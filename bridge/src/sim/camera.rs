//! Câmera simulada do `fake-vehicle`: desenha o bairro sintético (o mesmo que alimenta
//! o LiDAR) visto do drone, com o rumo do veículo e a inclinação do gimbal, e serve em
//! MJPEG por HTTP como um computador de bordo com `mjpg-streamer` faria.
//!
//! * `GET /video.mjpg` (ou `/`): fluxo `multipart/x-mixed-replace` de JPEGs;
//! * `GET /snapshot.jpg`: um quadro.
//!
//! Só desenha enquanto alguém está assistindo. Software puro: céu e chão por pixel,
//! prédios como polígonos (pintor, do mais longe para o mais perto).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const WIDTH: usize = 640;
pub const HEIGHT: usize = 360;
/// Campo de visão horizontal (graus).
const FOV_DEG: f64 = 78.0;
const FPS: f64 = 15.0;
/// Até onde os prédios são desenhados (m); depois só a névoa.
const FAR: f64 = 900.0;

#[derive(Clone, Copy)]
pub struct Block {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub h: f64,
}

/// Posição e orientação da câmera: leste/norte/altura (m) e rumo/inclinação (graus).
#[derive(Clone, Copy, Debug)]
pub struct Pose {
    pub e: f64,
    pub n: f64,
    pub alt: f64,
    pub hdg: f64,
    /// Inclinação absoluta do gimbal (0 = horizonte, −90 = para baixo). O gimbal estabiliza a rolagem.
    pub pitch: f64,
}

type V3 = [f64; 3];
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn hash(x: i64, y: i64) -> f64 {
    let mut h = (x as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (y as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 32;
    (h & 0xFFFF) as f64 / 65535.0
}

fn mix(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

const SKY_TOP: [f64; 3] = [70.0, 128.0, 205.0];
const SKY_LOW: [f64; 3] = [196.0, 218.0, 236.0];
const FOG: [f64; 3] = [190.0, 205.0, 215.0];
const SUN: V3 = [0.42, 0.33, 0.84];

/// Cor do chão no ponto (leste, norte): ruas a cada 60 m, quadras, parque e o heliponto do home.
fn ground(x: f64, y: f64) -> [f64; 3] {
    let (bx, by) = ((x / 60.0).floor(), (y / 60.0).floor());
    let (fx, fy) = (x - bx * 60.0, y - by * 60.0);
    let road_x = !(6.0..54.0).contains(&fx);
    let road_y = !(6.0..54.0).contains(&fy);
    let r = (x * x + y * y).sqrt();
    // Heliponto: círculo amarelo com um H.
    if r < 4.0 {
        let ring = (2.9..3.4).contains(&r);
        let h_mark = ((0.9..1.3).contains(&x.abs()) && y.abs() < 1.6) || (x.abs() < 1.0 && y.abs() < 0.2);
        return if ring || h_mark { [230.0, 196.0, 40.0] } else { [70.0, 74.0, 78.0] };
    }
    let n = hash((x * 1.5).floor() as i64, (y * 1.5).floor() as i64) * 14.0 - 7.0;
    if road_x || road_y {
        // Faixa central tracejada.
        let center = (road_x && (fx.min(60.0 - fx)) < 0.15 && (y.rem_euclid(8.0)) < 4.0) || (road_y && (fy.min(60.0 - fy)) < 0.15 && (x.rem_euclid(8.0)) < 4.0);
        if center {
            return [225.0, 225.0, 215.0];
        }
        // Calçada junto às quadras.
        let curb = (road_x && (4.5..6.0).contains(&fx.min(60.0 - fx).max(0.0)) && !road_y) || (road_y && (4.5..6.0).contains(&fy.min(60.0 - fy).max(0.0)) && !road_x);
        return if curb { [168.0 + n, 164.0 + n, 156.0 + n] } else { [84.0 + n, 86.0 + n, 90.0 + n] };
    }
    let park = (bx == -1.0 || bx == 0.0) && (by == -1.0 || by == 0.0);
    if park || hash(bx as i64, by as i64 + 77) < 0.1 {
        let patch = hash((x / 7.0).floor() as i64, (y / 7.0).floor() as i64) * 18.0;
        return [78.0 + n + patch * 0.4, 128.0 + n + patch, 62.0 + n];
    }
    [150.0 + n, 145.0 + n, 134.0 + n]
}

fn block_color(b: &Block) -> [f64; 3] {
    let w = (b.x1 - b.x0).min(b.y1 - b.y0);
    if w < 6.5 && b.h < 14.0 {
        // Árvores do parque.
        let k = hash(b.x0 as i64, b.y0 as i64) * 30.0;
        return [46.0 + k * 0.3, 102.0 + k, 50.0];
    }
    const PALETTE: [[f64; 3]; 6] = [[214.0, 200.0, 176.0], [186.0, 112.0, 82.0], [170.0, 172.0, 176.0], [228.0, 224.0, 214.0], [140.0, 150.0, 166.0], [198.0, 170.0, 120.0]];
    PALETTE[(hash((b.x0 * 3.0) as i64, (b.y0 * 7.0) as i64) * 5.99) as usize]
}

struct Cam {
    c: V3,
    f: V3,
    r: V3,
    u: V3,
    fpx: f64,
}

impl Cam {
    fn new(p: &Pose) -> Self {
        let (h, pt) = (p.hdg.to_radians(), p.pitch.clamp(-90.0, 30.0).to_radians());
        let f = [h.sin() * pt.cos(), h.cos() * pt.cos(), pt.sin()];
        let r = [h.cos(), -h.sin(), 0.0];
        let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
        Cam { c: [p.e, p.n, p.alt.max(0.3)], f, r, u, fpx: (WIDTH as f64 / 2.0) / (FOV_DEG.to_radians() / 2.0).tan() }
    }
    /// Coordenadas da câmera (direita, cima, frente).
    fn to_cam(&self, p: V3) -> V3 {
        let d = sub(p, self.c);
        [dot(d, self.r), dot(d, self.u), dot(d, self.f)]
    }
}

/// Preenche um polígono convexo já projetado (x, y em pixels) com uma cor.
fn fill(buf: &mut [u8], pts: &[(f64, f64)], col: [u8; 3]) {
    if pts.len() < 3 {
        return;
    }
    let ymin = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min).max(0.0).ceil() as i64;
    let ymax = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max).min(HEIGHT as f64 - 1.0).floor() as i64;
    for y in ymin..=ymax {
        let yc = y as f64 + 0.5;
        let (mut xl, mut xr) = (f64::INFINITY, f64::NEG_INFINITY);
        for i in 0..pts.len() {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            if (a.1 <= yc && b.1 > yc) || (b.1 <= yc && a.1 > yc) {
                let x = a.0 + (yc - a.1) / (b.1 - a.1) * (b.0 - a.0);
                xl = xl.min(x);
                xr = xr.max(x);
            }
        }
        if xl > xr {
            continue;
        }
        let (x0, x1) = (xl.max(0.0).round() as usize, xr.min(WIDTH as f64).round() as usize);
        let row = y as usize * WIDTH * 3;
        for x in x0..x1.min(WIDTH) {
            let i = row + x * 3;
            buf[i..i + 3].copy_from_slice(&col);
        }
    }
}

/// Desenha um quadro RGB (WIDTH × HEIGHT).
pub fn render(blocks: &[Block], pose: &Pose, buf: &mut [u8]) {
    let cam = Cam::new(pose);
    let (cx, cy) = (WIDTH as f64 / 2.0, HEIGHT as f64 / 2.0);
    // Céu e chão, pixel a pixel.
    for y in 0..HEIGHT {
        let b = (cy - y as f64 - 0.5) / cam.fpx;
        for x in 0..WIDTH {
            let a = (x as f64 + 0.5 - cx) / cam.fpx;
            let d = [cam.f[0] + cam.r[0] * a + cam.u[0] * b, cam.f[1] + cam.r[1] * a + cam.u[1] * b, cam.f[2] + cam.r[2] * a + cam.u[2] * b];
            let len = dot(d, d).sqrt();
            let col = if d[2] < -1e-4 {
                let t = -cam.c[2] / d[2];
                let (gx, gy) = (cam.c[0] + d[0] * t, cam.c[1] + d[1] * t);
                let dist = t * len;
                mix(ground(gx, gy), FOG, 1.0 - (-dist / 650.0).exp())
            } else {
                let el = (d[2] / len).clamp(0.0, 1.0);
                mix(SKY_LOW, SKY_TOP, el.powf(0.6))
            };
            let i = (y * WIDTH + x) * 3;
            buf[i] = col[0] as u8;
            buf[i + 1] = col[1] as u8;
            buf[i + 2] = col[2] as u8;
        }
    }
    // Prédios: do mais longe para o mais perto.
    let mut vis: Vec<(f64, &Block)> = blocks
        .iter()
        .filter_map(|b| {
            let mid = [(b.x0 + b.x1) / 2.0, (b.y0 + b.y1) / 2.0, b.h / 2.0];
            let d = sub(mid, cam.c);
            let dist = dot(d, d).sqrt();
            let rad = ((b.x1 - b.x0).powi(2) + (b.y1 - b.y0).powi(2) + b.h * b.h).sqrt() / 2.0;
            (dist < FAR && dot(d, cam.f) > -rad).then_some((dist, b))
        })
        .collect();
    vis.sort_by(|a, b| b.0.total_cmp(&a.0));
    const NEAR: f64 = 0.15;
    for (dist, b) in vis {
        let base = block_color(b);
        let fog = 1.0 - (-dist / 650.0).exp();
        let faces: [(V3, [V3; 4]); 5] = [
            ([0.0, 0.0, 1.0], [[b.x0, b.y0, b.h], [b.x1, b.y0, b.h], [b.x1, b.y1, b.h], [b.x0, b.y1, b.h]]),
            ([-1.0, 0.0, 0.0], [[b.x0, b.y0, 0.0], [b.x0, b.y1, 0.0], [b.x0, b.y1, b.h], [b.x0, b.y0, b.h]]),
            ([1.0, 0.0, 0.0], [[b.x1, b.y0, 0.0], [b.x1, b.y1, 0.0], [b.x1, b.y1, b.h], [b.x1, b.y0, b.h]]),
            ([0.0, -1.0, 0.0], [[b.x0, b.y0, 0.0], [b.x1, b.y0, 0.0], [b.x1, b.y0, b.h], [b.x0, b.y0, b.h]]),
            ([0.0, 1.0, 0.0], [[b.x0, b.y1, 0.0], [b.x1, b.y1, 0.0], [b.x1, b.y1, b.h], [b.x0, b.y1, b.h]]),
        ];
        for (n, quad) in faces {
            // Só as faces viradas para a câmera.
            if dot(n, sub(cam.c, quad[0])) <= 0.0 {
                continue;
            }
            let shade = if n[2] > 0.5 { 0.78 } else { 0.5 + 0.5 * dot(n, SUN).max(0.0) / (1.0 - SUN[2] * SUN[2]).sqrt() };
            let roof = if n[2] > 0.5 { [0.82, 0.8, 0.8] } else { [1.0, 1.0, 1.0] };
            let lit = [base[0] * shade * roof[0], base[1] * shade * roof[1], base[2] * shade * roof[2]];
            let c = mix(lit, FOG, fog);
            // Recorte no plano próximo (Sutherland–Hodgman) e projeção.
            let pc: Vec<V3> = quad.iter().map(|p| cam.to_cam(*p)).collect();
            let mut clipped: Vec<V3> = Vec::with_capacity(6);
            for i in 0..4 {
                let (a, bq) = (pc[i], pc[(i + 1) % 4]);
                let (ina, inb) = (a[2] > NEAR, bq[2] > NEAR);
                if ina {
                    clipped.push(a);
                }
                if ina != inb {
                    let t = (NEAR - a[2]) / (bq[2] - a[2]);
                    clipped.push([a[0] + (bq[0] - a[0]) * t, a[1] + (bq[1] - a[1]) * t, NEAR]);
                }
            }
            let pts: Vec<(f64, f64)> = clipped.iter().map(|p| (cx + cam.fpx * p[0] / p[2], cy - cam.fpx * p[1] / p[2])).collect();
            fill(buf, &pts, [c[0] as u8, c[1] as u8, c[2] as u8]);
        }
    }
}

/// Último quadro em JPEG e quantos estão assistindo.
#[derive(Default)]
pub struct Bus {
    frame: Mutex<(u64, Arc<Vec<u8>>)>,
    ready: Condvar,
    pub viewers: AtomicUsize,
}

impl Bus {
    pub fn publish(&self, jpeg: Vec<u8>) {
        let mut f = self.frame.lock().unwrap();
        f.0 += 1;
        f.1 = Arc::new(jpeg);
        self.ready.notify_all();
    }
    fn seq(&self) -> u64 {
        self.frame.lock().unwrap().0
    }
    /// Espera um quadro mais novo que `seen` (até 2 s).
    fn next(&self, seen: u64) -> Option<(u64, Arc<Vec<u8>>)> {
        let f = self.frame.lock().unwrap();
        let (f, _) = self.ready.wait_timeout_while(f, Duration::from_secs(2), |f| f.0 <= seen).unwrap();
        (f.0 > seen).then(|| (f.0, f.1.clone()))
    }
}

pub fn encode(rgb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(60_000);
    let enc = jpeg_encoder::Encoder::new(&mut out, 75);
    enc.encode(rgb, WIDTH as u16, HEIGHT as u16, jpeg_encoder::ColorType::Rgb).expect("JPEG em memória");
    out
}

/// Desenha a ~15 quadros/s enquanto houver quem assista. `pose` dá a posição atual.
pub fn run(blocks: Vec<Block>, bus: Arc<Bus>, pose: impl Fn() -> Pose + Send + 'static) {
    std::thread::Builder::new()
        .name("camera".into())
        .spawn(move || {
            let mut buf = vec![0u8; WIDTH * HEIGHT * 3];
            loop {
                let t0 = Instant::now();
                if bus.viewers.load(Ordering::Relaxed) > 0 {
                    render(&blocks, &pose(), &mut buf);
                    bus.publish(encode(&buf));
                }
                std::thread::sleep(Duration::from_secs_f64(1.0 / FPS).saturating_sub(t0.elapsed()));
            }
        })
        .expect("thread da câmera");
}

/// Servidor HTTP do vídeo. Falha ao abrir a porta só desliga a câmera.
pub fn serve(addr: &str, bus: Arc<Bus>) -> std::io::Result<()> {
    let l = TcpListener::bind(addr)?;
    std::thread::Builder::new()
        .name("camera-http".into())
        .spawn(move || {
            for s in l.incoming().flatten() {
                let bus = bus.clone();
                std::thread::spawn(move || {
                    let _ = client(s, &bus);
                });
            }
        })
        .expect("thread do servidor da câmera");
    Ok(())
}

fn client(mut s: TcpStream, bus: &Bus) -> std::io::Result<()> {
    let mut line = String::new();
    BufReader::new(s.try_clone()?).read_line(&mut line)?;
    let path = line.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let head = |ctype: &str| format!("HTTP/1.0 200 OK\r\nContent-Type: {ctype}\r\nCache-Control: no-cache, no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
    bus.viewers.fetch_add(1, Ordering::Relaxed);
    struct Leave<'a>(&'a Bus);
    impl Drop for Leave<'_> {
        fn drop(&mut self) {
            self.0.viewers.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let _leave = Leave(bus);
    match path.as_str() {
        "/snapshot.jpg" => {
            // Quadro novo: enquanto ninguém assistia, o último ficou parado.
            let Some((_, jpg)) = bus.next(bus.seq()) else { return Ok(()) };
            s.write_all(head("image/jpeg").as_bytes())?;
            s.write_all(&jpg)
        }
        "/" | "/video.mjpg" | "/video" | "/stream" => {
            s.write_all(head("multipart/x-mixed-replace; boundary=frame").as_bytes())?;
            let mut seen = bus.seq();
            loop {
                let Some((n, jpg)) = bus.next(seen) else { continue };
                seen = n;
                s.write_all(format!("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", jpg.len()).as_bytes())?;
                s.write_all(&jpg)?;
                s.write_all(b"\r\n")?;
            }
        }
        _ => s.write_all(b"HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mean(buf: &[u8], rows: std::ops::Range<usize>) -> [f64; 3] {
        let mut s = [0.0; 3];
        let mut n = 0.0;
        for y in rows {
            for x in 0..WIDTH {
                let i = (y * WIDTH + x) * 3;
                for c in 0..3 {
                    s[c] += buf[i + c] as f64;
                }
                n += 1.0;
            }
        }
        s.map(|v| v / n)
    }

    #[test]
    fn horizonte_ceu_em_cima_chao_embaixo() {
        let mut buf = vec![0u8; WIDTH * HEIGHT * 3];
        // Câmera nivelada no meio de um parque vazio: céu azul em cima, chão embaixo.
        render(&[], &Pose { e: 30.0, n: -30.0, alt: 20.0, hdg: 0.0, pitch: 0.0 }, &mut buf);
        let top = mean(&buf, 0..40);
        assert!(top[2] > top[0] + 40.0, "céu azul: {top:?}");
        let bottom = mean(&buf, HEIGHT - 40..HEIGHT);
        assert!(bottom[2] < bottom[1], "chão não é azul: {bottom:?}");
        // Olhando para baixo: só chão.
        render(&[], &Pose { e: 30.0, n: -30.0, alt: 20.0, hdg: 0.0, pitch: -90.0 }, &mut buf);
        let all = mean(&buf, 0..HEIGHT);
        assert!(all[2] < all[1], "só chão: {all:?}");
    }

    #[test]
    fn predio_na_frente_aparece_e_atras_nao() {
        let b = Block { x0: -10.0, y0: 40.0, x1: 10.0, y1: 60.0, h: 60.0 };
        let mut a = vec![0u8; WIDTH * HEIGHT * 3];
        let mut c = vec![0u8; WIDTH * HEIGHT * 3];
        render(&[], &Pose { e: 0.0, n: 0.0, alt: 10.0, hdg: 0.0, pitch: 0.0 }, &mut a);
        render(&[b], &Pose { e: 0.0, n: 0.0, alt: 10.0, hdg: 0.0, pitch: 0.0 }, &mut c);
        let i = (HEIGHT / 3 * WIDTH + WIDTH / 2) * 3;
        assert_ne!(&a[i..i + 3], &c[i..i + 3], "o prédio cobre o céu no centro");
        render(&[b], &Pose { e: 0.0, n: 0.0, alt: 10.0, hdg: 180.0, pitch: 0.0 }, &mut c);
        assert_eq!(&mean(&c, 0..HEIGHT).map(|v| v.round()), &{
            render(&[], &Pose { e: 0.0, n: 0.0, alt: 10.0, hdg: 180.0, pitch: 0.0 }, &mut a);
            mean(&a, 0..HEIGHT).map(|v| v.round())
        }, "de costas não aparece");
        // Câmera dentro do prédio não quebra o recorte.
        render(&[b], &Pose { e: 0.0, n: 50.0, alt: 5.0, hdg: 0.0, pitch: 0.0 }, &mut c);
    }

    #[test]
    fn jpeg_valido() {
        let mut buf = vec![0u8; WIDTH * HEIGHT * 3];
        render(&[], &Pose { e: 0.0, n: 0.0, alt: 30.0, hdg: 45.0, pitch: -30.0 }, &mut buf);
        let j = encode(&buf);
        assert_eq!(&j[..2], &[0xFF, 0xD8]);
        assert!(j.len() > 3000);
    }
}
