//! Veículo simulado para testar a ponte e a interface sem SITL nem hardware.
//!
//! Fala MAVLink como um ArduCopter simplificado (modos, armar, decolar,
//! missão, parâmetros, controle manual) e envia quadros de mapa LiDAR
//! sintéticos no mesmo formato do nó `map_link` do ROS 2.
//!
//!   cargo run --bin fake-vehicle
//!
//! Não substitui o SITL do ArduPilot para validar voo: a física é cinemática.
#![allow(deprecated)]

use aracua_bridge::{apm::*, char_array_to_string, mapframe, modes};
use clap::Parser;
use mavlink::{MavConnection, MavHeader};
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(about = "Veículo MAVLink simulado para testes da estação Aracuã-7")]
struct Args {
    /// Para onde enviar MAVLink (a ponte escuta em udpin:0.0.0.0:14550)
    #[arg(long, default_value = "udpout:127.0.0.1:14550")]
    mavlink: String,
    /// Para onde enviar o mapa LiDAR simulado
    #[arg(long, default_value = "127.0.0.1:14600")]
    map: String,
    /// Latitude e longitude do home
    #[arg(long, default_value_t = -23.55052)]
    lat: f64,
    #[arg(long, default_value_t = -46.63331)]
    lon: f64,
    /// Sai quando a entrada padrão fechar (usado pelo app desktop)
    #[arg(long)]
    exit_with_parent: bool,
}

const HOME_MSL: f32 = 760.0;
const LIDAR_RANGE: f64 = 90.0;

#[derive(Clone, Copy)]
struct Bx {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    h: f64,
}

/// Mesmo "bairro" procedural da interface de demonstração.
fn world() -> Vec<Bx> {
    let mut s: u32 = 11;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s as f64) / (u32::MAX as f64)
    };
    let mut out = vec![];
    for bi in -5..5 {
        for bj in -5..5 {
            let (x0, x1, y0, y1) = (bi as f64 * 60.0 + 6.0, (bi + 1) as f64 * 60.0 - 6.0, bj as f64 * 60.0 + 6.0, (bj + 1) as f64 * 60.0 - 6.0);
            let park = (bi == -1 || bi == 0) && (bj == -1 || bj == 0);
            if park || rnd() < 0.1 {
                for _ in 0..14 {
                    let (cx, cy) = (x0 + 3.0 + rnd() * (x1 - x0 - 6.0), y0 + 3.0 + rnd() * (y1 - y0 - 6.0));
                    if cx.hypot(cy) < 18.0 {
                        continue;
                    }
                    let r = 1.3 + rnd() * 1.6;
                    out.push(Bx { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, h: 5.0 + rnd() * 8.0 });
                }
                continue;
            }
            let nx = 1 + (rnd() * 2.0) as i32;
            let ny = 1 + (rnd() * 3.0) as i32;
            let (lw, lh) = ((x1 - x0) / nx as f64, (y1 - y0) / ny as f64);
            for i in 0..nx {
                for j in 0..ny {
                    if rnd() < 0.12 {
                        continue;
                    }
                    let ins = 1.5 + rnd() * 2.5;
                    let b = Bx { x0: x0 + i as f64 * lw + ins, y0: y0 + j as f64 * lh + ins, x1: x0 + (i + 1) as f64 * lw - ins, y1: y0 + (j + 1) as f64 * lh - ins, h: 0.0 };
                    let tall = (1.0 - ((b.x0 + b.x1) / 2.0 - 90.0).hypot((b.y0 + b.y1) / 2.0 - 70.0) / 300.0).max(0.25);
                    out.push(Bx { h: (5.0 + rnd() * 24.0 * tall + if rnd() < 0.07 { 12.0 } else { 0.0 }).min(39.0), ..b });
                }
            }
        }
    }
    out
}

fn ray(o: [f64; 3], d: [f64; 3], max: f64, boxes: &[&Bx]) -> Option<(f64, bool)> {
    let mut best = max;
    let mut ground = false;
    let mut hit = false;
    if d[2] < -1e-6 {
        let t = -o[2] / d[2];
        if t > 0.0 && t < best {
            best = t;
            ground = true;
            hit = true;
        }
    }
    for b in boxes {
        let (mut tmin, mut tmax) = (0.0f64, best);
        let mut ok = true;
        for (a, lo, hi) in [(0, b.x0, b.x1), (1, b.y0, b.y1), (2, 0.0, b.h)] {
            if d[a].abs() < 1e-9 {
                if o[a] < lo || o[a] > hi {
                    ok = false;
                    break;
                }
            } else {
                let (mut t1, mut t2) = ((lo - o[a]) / d[a], (hi - o[a]) / d[a]);
                if t1 > t2 {
                    std::mem::swap(&mut t1, &mut t2);
                }
                tmin = tmin.max(t1);
                tmax = tmax.min(t2);
                if tmin > tmax {
                    ok = false;
                    break;
                }
            }
        }
        if ok && tmin < best {
            best = tmin;
            ground = false;
            hit = true;
        }
    }
    hit.then_some((best, ground))
}

struct Vehicle {
    e: f64,
    n: f64,
    alt: f64,
    ve: f64,
    vn: f64,
    vz: f64,
    hdg: f64,
    roll: f64,
    pitch: f64,
    yaw_rate: f64,
    armed: bool,
    mode: u32,
    target_alt: f64,
    guided_target: Option<(f64, f64)>,
    mission: Vec<MISSION_ITEM_INT_DATA>,
    incoming: Option<(u16, Vec<MISSION_ITEM_INT_DATA>)>,
    cur: u16,
    manual: (f64, f64, f64, f64, Instant),
    used_mah: f64,
    current: f64,
    landed_t: f64,
    params: HashMap<String, f32>,
    texts: Vec<(MavSeverity, String)>,
    boot: Instant,
    /// Saídas de servo 1–16 (0 = sem sinal).
    servo: [u16; 16],
    relay: [bool; 8],
    /// Carga presente em cada compartimento (bit da chave 0–5) e quando foi recolocada.
    present: [bool; 6],
    refill_at: [Option<Instant>; 6],
    loiter_until: Option<Instant>,
}

/// Bit da chave de cada saída de entrega da placa Aracuã-7.
fn switch_bit(ch: usize) -> Option<usize> {
    match ch {
        5..=8 => Some(ch - 5),
        10 => Some(4),
        11 => Some(5),
        _ => None,
    }
}

impl Vehicle {
    fn say(&mut self, sev: MavSeverity, t: impl Into<String>) {
        self.texts.push((sev, t.into()));
    }
    /// MAV_CMD_DO_SET_SERVO: move a saída; se for um compartimento e o pino abrir, a carga cai.
    fn set_servo(&mut self, ch: usize, pwm: u16) -> bool {
        if !(1..=16).contains(&ch) || (1..=4).contains(&ch) {
            return false;
        }
        self.servo[ch - 1] = pwm;
        if let Some(b) = switch_bit(ch) {
            if pwm >= 1500 && self.present[b] {
                self.present[b] = false;
                self.refill_at[b] = None;
                let alt = self.alt;
                self.say(MavSeverity::MAV_SEVERITY_INFO, format!("Entrega: carga da saída {ch} solta a {alt:.1} m"));
            }
        }
        true
    }
    fn set_mode(&mut self, m: u32) -> bool {
        if modes::mode_name(m).starts_with("MODE_") {
            return false;
        }
        if m == 3 && self.mission.len() < 2 {
            self.say(MavSeverity::MAV_SEVERITY_WARNING, "Mission: nenhuma missão carregada");
            return false;
        }
        self.mode = m;
        if m == 3 {
            self.cur = 1;
        }
        if m == 4 {
            self.guided_target = None;
            self.target_alt = self.alt;
        }
        true
    }
}

fn wrap(a: f64) -> f64 {
    (a + 540.0) % 360.0 - 180.0
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    if args.exit_with_parent {
        aracua_bridge::exit_when_stdin_closes();
    }
    let conn = Arc::new(mavlink::connect::<MavMessage>(&args.mavlink)?);
    let map_sock = UdpSocket::bind("0.0.0.0:0")?;
    let boxes = world();
    let (home_lat, home_lon) = (args.lat, args.lon);
    let to_ll = |e: f64, n: f64| (home_lat + n / 111_320.0, home_lon + e / (111_320.0 * (home_lat * PI / 180.0).cos()));
    let to_en = |lat: f64, lon: f64| ((lon - home_lon) * 111_320.0 * (home_lat * PI / 180.0).cos(), (lat - home_lat) * 111_320.0);

    let params: HashMap<String, f32> = [
        ("FENCE_ENABLE", 1.0), ("FENCE_RADIUS", 400.0), ("FENCE_ACTION", 1.0), ("RTL_ALT", 3000.0),
        ("BATT_LOW_MAH", 750.0), ("BATT_FS_LOW_ACT", 2.0), ("FS_GCS_ENABLE", 1.0), ("WPNAV_SPEED", 900.0),
        ("LOIT_SPEED", 1200.0), ("PILOT_SPEED_UP", 400.0), ("AVOID_ENABLE", 7.0), ("AVOID_DIST_MAX", 9.0),
        ("PILOT_TKOFF_ALT", 4200.0),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();

    let v = Arc::new(Mutex::new(Vehicle {
        e: 0.0, n: 0.0, alt: 0.0, ve: 0.0, vn: 0.0, vz: 0.0, hdg: 48.0, roll: 0.0, pitch: 0.0, yaw_rate: 0.0,
        armed: false, mode: 5, target_alt: 0.0, guided_target: None, mission: vec![], incoming: None, cur: 0,
        manual: (0.0, 0.0, 0.5, 0.0, Instant::now()), used_mah: 0.0, current: 0.0, landed_t: 0.0, params,
        texts: vec![], boot: Instant::now(), servo: [0; 16], relay: [false; 8],
        present: [true, true, true, true, false, false], refill_at: [None; 6], loiter_until: None,
    }));
    v.lock().unwrap().say(MavSeverity::MAV_SEVERITY_INFO, "ArduCopter simulado (Aracuã-7) pronto");

    let seq = Arc::new(Mutex::new(0u8));
    let send = {
        let (conn, seq) = (conn.clone(), seq.clone());
        move |m: MavMessage| {
            let s = {
                let mut s = seq.lock().unwrap();
                *s = s.wrapping_add(1);
                *s
            };
            let _ = conn.send(&MavHeader { system_id: 1, component_id: 1, sequence: s }, &m);
        }
    };
    let ack = |send: &dyn Fn(MavMessage), c: MavCmd, ok: bool| {
        send(MavMessage::COMMAND_ACK(COMMAND_ACK_DATA {
            command: c,
            result: if ok { MavResult::MAV_RESULT_ACCEPTED } else { MavResult::MAV_RESULT_DENIED },
            ..Default::default()
        }))
    };
    let param_msg = |id: &str, val: f32, idx: u16, count: u16| {
        MavMessage::PARAM_VALUE(PARAM_VALUE_DATA { param_value: val, param_count: count, param_index: idx, param_id: id.into(), param_type: MavParamType::MAV_PARAM_TYPE_REAL32 })
    };

    // Recepção de comandos.
    {
        let (conn, v, send) = (conn.clone(), v.clone(), send.clone());
        std::thread::spawn(move || loop {
            // Envia um HEARTBEAT antes de ler: com udpout, é isso que "abre" o caminho de volta.
            let Ok((_, msg)) = conn.recv() else { continue };
            let mut s = v.lock().unwrap();
            match msg {
                MavMessage::COMMAND_LONG(c) => match c.command {
                    MavCmd::MAV_CMD_COMPONENT_ARM_DISARM => {
                        let arm = c.param1 > 0.5;
                        let ok = if arm {
                            let armable = [2, 4, 5, 16, 0].contains(&s.mode);
                            if !armable {
                                s.say(MavSeverity::MAV_SEVERITY_CRITICAL, "Arm: modo não permite armar");
                            }
                            armable && !s.armed
                        } else {
                            s.alt < 0.3 || c.param2 == 21196.0
                        };
                        if ok {
                            s.armed = arm;
                            s.landed_t = 0.0;
                            let t = if arm { "Motores armados" } else { "Motores desarmados" };
                            s.say(MavSeverity::MAV_SEVERITY_INFO, t);
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_SET_MODE => {
                        let ok = s.set_mode(c.param2 as u32);
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_NAV_TAKEOFF => {
                        let ok = s.armed && s.mode == 4 && s.alt < 1.0;
                        if ok {
                            s.target_alt = c.param7 as f64;
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Decolando para {:.0} m", c.param7));
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_MISSION_START => {
                        let ok = s.armed && s.mission.len() > 1;
                        if ok {
                            s.mode = 3;
                            s.cur = 1;
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_SET_SERVO => {
                        let ok = s.set_servo(c.param1 as usize, c.param2 as u16);
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_SET_RELAY => {
                        let i = c.param1 as usize;
                        let ok = i < 8;
                        if ok {
                            s.relay[i] = c.param2 > 0.5;
                            let st = if s.relay[i] { "ligado" } else { "desligado" };
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Relé {} {}", i + 1, st));
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_DIGICAM_CONTROL => {
                        s.say(MavSeverity::MAV_SEVERITY_INFO, "Câmera: foto capturada");
                        ack(&send, c.command, true)
                    }
                    _ => ack(&send, c.command, true),
                },
                MavMessage::MANUAL_CONTROL(m) => {
                    s.manual = (m.x as f64 / 1000.0, m.y as f64 / 1000.0, m.z as f64 / 1000.0, m.r as f64 / 1000.0, Instant::now());
                }
                MavMessage::MISSION_COUNT(c) => {
                    s.incoming = Some((c.count, vec![]));
                    if c.count > 0 {
                        send(MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA { seq: 0, target_system: 255, target_component: 190, ..Default::default() }));
                    }
                }
                MavMessage::MISSION_ITEM_INT(it) => {
                    if let Some((count, mut items)) = s.incoming.take() {
                        if it.seq as usize == items.len() {
                            items.push(it);
                        }
                        if items.len() as u16 == count {
                            let n = items.len();
                            s.mission = items;
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Missão recebida: {} itens", n));
                            send(MavMessage::MISSION_ACK(MISSION_ACK_DATA { target_system: 255, target_component: 190, mavtype: MavMissionResult::MAV_MISSION_ACCEPTED, ..Default::default() }));
                        } else {
                            let next = items.len() as u16;
                            s.incoming = Some((count, items));
                            send(MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA { seq: next, target_system: 255, target_component: 190, ..Default::default() }));
                        }
                    }
                }
                MavMessage::PARAM_REQUEST_READ(p) => {
                    let id = char_array_to_string(&p.param_id);
                    let mut keys: Vec<_> = s.params.keys().cloned().collect();
                    keys.sort();
                    if let Some(i) = keys.iter().position(|k| *k == id) {
                        send(param_msg(&id, s.params[&id], i as u16, keys.len() as u16));
                    }
                }
                MavMessage::PARAM_SET(p) => {
                    let id = char_array_to_string(&p.param_id);
                    if s.params.contains_key(&id) {
                        s.params.insert(id.clone(), p.param_value);
                        let mut keys: Vec<_> = s.params.keys().cloned().collect();
                        keys.sort();
                        let i = keys.iter().position(|k| *k == id).unwrap_or(0);
                        send(param_msg(&id, p.param_value, i as u16, keys.len() as u16));
                    }
                }
                _ => {}
            }
        });
    }

    // Laço de simulação a 50 Hz.
    let dt = 0.02;
    let mut tick: u64 = 0;
    let mut seen: HashSet<(i16, i16, i16)> = HashSet::new();
    let mut pending: Vec<mapframe::Voxel> = vec![];
    let mut sectors = vec![u16::MAX; 72];
    let mut az: usize = 0;
    let mut first_map = true;
    let mut wind = (0.0f64, 0.0f64);
    let start = Instant::now();
    loop {
        let t0 = Instant::now();
        tick += 1;
        let mut s = v.lock().unwrap();
        let params = s.params.clone();
        let p = |k: &str, d: f32| params.get(k).copied().unwrap_or(d) as f64;
        let (wp_speed, loit_speed, climb, rtl_alt) = (p("WPNAV_SPEED", 900.0) / 100.0, p("LOIT_SPEED", 1200.0) / 100.0, p("PILOT_SPEED_UP", 400.0) / 100.0, p("RTL_ALT", 3000.0) / 100.0);
        let fence = (p("FENCE_ENABLE", 1.0) > 0.5, p("FENCE_RADIUS", 400.0));
        let avoid_dist = if p("AVOID_ENABLE", 7.0) > 0.0 { p("AVOID_DIST_MAX", 9.0) } else { 0.0 };
        let (fx, fy) = (s.hdg.to_radians().sin(), s.hdg.to_radians().cos());
        let (mut de, mut dn, mut dz, mut dyaw) = (0.0, 0.0, 0.0, 0.0);
        // Velocidade desejada para ir até um ponto: (leste, norte, subida, guinada, distância).
        let goto = |s: &Vehicle, te: f64, tn: f64, ta: f64, spd: f64| -> (f64, f64, f64, f64, f64) {
            let (ex, ny) = (te - s.e, tn - s.n);
            let d = ex.hypot(ny);
            let sp = spd.min(d * 0.5);
            let (a, b) = if d > 0.05 { (ex / d * sp, ny / d * sp) } else { (0.0, 0.0) };
            let yaw = if d > 3.0 { (wrap(ex.atan2(ny).to_degrees() - s.hdg) * 1.6).clamp(-70.0, 70.0) } else { 0.0 };
            (a, b, ((ta - s.alt) * 0.8).clamp(-2.5, 3.5), yaw, d)
        };
        if s.armed {
            let (mx, my, mz, mr, mt) = s.manual;
            let fresh = mt.elapsed() < Duration::from_millis(600);
            match modes::mode_name(s.mode).as_str() {
                "LOITER" | "POSHOLD" | "ALT_HOLD" | "STABILIZE" => {
                    if fresh {
                        let (fw, rt) = (mx * loit_speed, my * loit_speed);
                        de = fx * fw + fy * rt;
                        dn = fy * fw - fx * rt;
                        dz = (mz - 0.5) * 2.0 * climb;
                        dyaw = mr * 80.0;
                    }
                }
                "GUIDED" => {
                    let (te, tn) = s.guided_target.unwrap_or((s.e, s.n));
                    let ta = s.target_alt;
                    (de, dn, dz, dyaw, _) = goto(&s, te, tn, ta, wp_speed);
                }
                "AUTO" => {
                    let idx = s.cur as usize;
                    match s.mission.get(idx).cloned() {
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_TAKEOFF => {
                            dz = ((it.z as f64 - s.alt) * 0.9).clamp(0.4, 3.5);
                            if s.alt >= it.z as f64 - 0.5 {
                                s.cur += 1;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                            }
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_WAYPOINT => {
                            let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                            let d;
                            (de, dn, dz, dyaw, d) = goto(&s, te, tn, it.z as f64, wp_speed);
                            if d < 2.0 && (s.alt - it.z as f64).abs() < 1.5 {
                                s.cur += 1;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                            }
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_DO_SET_SERVO => {
                            s.set_servo(it.param1 as usize, it.param2 as u16);
                            s.cur += 1;
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_DO_SET_RELAY => {
                            let i = (it.param1 as usize).min(7);
                            s.relay[i] = it.param2 > 0.5;
                            s.cur += 1;
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_LOITER_TIME => {
                            let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                            let d;
                            (de, dn, dz, dyaw, d) = goto(&s, te, tn, it.z as f64, wp_speed);
                            if d < 2.0 {
                                let until = *s.loiter_until.get_or_insert(Instant::now() + Duration::from_secs_f32(it.param1.max(0.0)));
                                if Instant::now() >= until {
                                    s.loiter_until = None;
                                    s.cur += 1;
                                    s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                                }
                            }
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH => {
                            s.mode = 6;
                        }
                        _ => {
                            s.mode = 5;
                            s.say(MavSeverity::MAV_SEVERITY_INFO, "Missão concluída, mantendo posição");
                        }
                    }
                }
                "RTL" => {
                    let ra = rtl_alt.max(s.alt.min(rtl_alt + 50.0));
                    if s.alt < ra - 1.5 && s.e.hypot(s.n) > 3.0 {
                        dz = 2.5;
                    } else {
                        let d;
                        (de, dn, dz, dyaw, d) = goto(&s, 0.0, 0.0, ra, wp_speed);
                        if d < 1.5 {
                            s.mode = 9;
                        }
                    }
                }
                "LAND" => dz = if s.alt > 6.0 { -2.0 } else { -0.7 },
                _ => {}
            }
            if s.mode == 4 && s.alt < 0.3 && s.target_alt < 0.5 {
                dz = 0.0;
            }
        }
        // Anticolisão simples usando os setores do LiDAR.
        let sp = de.hypot(dn);
        if avoid_dist > 0.0 && sp > 0.3 && s.alt > 0.5 {
            let rel = wrap(de.atan2(dn).to_degrees() - s.hdg).rem_euclid(360.0);
            let sec = ((rel / 5.0).round() as usize) % 72;
            let near = [71, 0, 1].iter().map(|o| sectors[(sec + o) % 72]).min().unwrap_or(u16::MAX);
            if near != u16::MAX {
                let o = near as f64 / 100.0;
                if o < avoid_dist {
                    let k = ((o - avoid_dist * 0.45) / (avoid_dist * 0.55)).clamp(0.0, 1.0);
                    de *= k;
                    dn *= k;
                }
            }
        }
        let air = s.alt > 0.15;
        let k = 1.0 - (-dt * 2.0f64).exp();
        let (pve, pvn) = (s.ve, s.vn);
        s.ve += (de - s.ve) * k;
        s.vn += (dn - s.vn) * k;
        s.vz += (dz - s.vz) * (1.0 - (-dt * 3.0f64).exp());
        if air {
            wind.0 += (rand_gauss(tick) * 1.2 - wind.0) * dt * 0.8;
            wind.1 += (rand_gauss(tick + 7) * 1.2 - wind.1) * dt * 0.8;
            s.ve += wind.0 * dt * 0.6;
            s.vn += wind.1 * dt * 0.6;
        }
        s.yaw_rate += (dyaw - s.yaw_rate) * (1.0 - (-dt * 4.0f64).exp());
        s.hdg = (s.hdg + s.yaw_rate * dt).rem_euclid(360.0);
        let (pe, pn) = (s.e, s.n);
        s.e += s.ve * dt;
        s.n += s.vn * dt;
        s.alt += s.vz * dt;
        if s.alt <= 0.0 {
            s.alt = 0.0;
            s.vz = s.vz.max(0.0);
            s.ve *= 0.5;
            s.vn *= 0.5;
        }
        if boxes.iter().any(|b| s.e > b.x0 - 0.4 && s.e < b.x1 + 0.4 && s.n > b.y0 - 0.4 && s.n < b.y1 + 0.4 && s.alt < b.h) {
            s.e = pe;
            s.n = pn;
            s.ve = 0.0;
            s.vn = 0.0;
        }
        let (vf, vr) = (s.ve * fx + s.vn * fy, s.ve * fy - s.vn * fx);
        let (af, ar) = (((s.ve - pve) * fx + (s.vn - pvn) * fy) / dt, ((s.ve - pve) * fy - (s.vn - pvn) * fx) / dt);
        s.pitch += ((-(vf * 1.2 + af * 2.4)).clamp(-35.0, 35.0) - s.pitch) * 0.1;
        s.roll += ((vr * 1.2 + ar * 2.4).clamp(-35.0, 35.0) - s.roll) * 0.1;
        if s.armed && s.alt < 0.05 && [9, 6].contains(&s.mode) {
            s.landed_t += dt;
            if s.landed_t > 1.5 {
                s.armed = false;
                s.mode = 5;
                s.say(MavSeverity::MAV_SEVERITY_INFO, "Pouso concluído, motores desarmados");
            }
        }
        let cur = if !s.armed { 0.4 } else if air { 16.0 + sp * 0.9 + s.vz.max(0.0) * 5.0 } else { 2.2 };
        s.current += (cur - s.current) * 0.05;
        s.used_mah += s.current * dt / 3.6;
        let soc = (1.0 - s.used_mah / 5000.0).clamp(0.0, 1.0);
        if fence.0 && air && s.e.hypot(s.n) > fence.1 && ![6, 9].contains(&s.mode) {
            s.mode = 6;
            s.say(MavSeverity::MAV_SEVERITY_CRITICAL, "Geocerca violada: RTL");
        }
        if air && soc * 5000.0 < p("BATT_LOW_MAH", 750.0) && ![6, 9].contains(&s.mode) {
            s.mode = 6;
            s.say(MavSeverity::MAV_SEVERITY_CRITICAL, "Bateria baixa: RTL");
        }

        // ---- LiDAR sintético ----
        let origin = [s.e, s.n, s.alt.max(0.3) + 0.1];
        let near: Vec<&Bx> = boxes.iter().filter(|b| ((b.x0 + b.x1) / 2.0 - s.e).hypot((b.y0 + b.y1) / 2.0 - s.n) < LIDAR_RANGE + 30.0).collect();
        for _ in 0..8 {
            az = (az + 1) % 180;
            let a = (s.hdg + az as f64 * 2.0).to_radians();
            let mut best = u16::MAX;
            for el in [-30.0f64, -22.0, -15.0, -9.0, -4.0, 0.0, 4.0, 10.0] {
                let (ce, se) = (el.to_radians().cos(), el.to_radians().sin());
                let d = [ce * a.sin(), ce * a.cos(), se];
                if let Some((t, g)) = ray(origin, d, LIDAR_RANGE, &near) {
                    let (x, y, z) = (origin[0] + d[0] * t, origin[1] + d[1] * t, (origin[2] + d[2] * t).max(0.0));
                    let key = if g { ((x / 2.0).round() as i16 * 2, (y / 2.0).round() as i16 * 2, 0) } else { (x.round() as i16, y.round() as i16, z.round() as i16) };
                    if seen.insert(key) {
                        pending.push(mapframe::Voxel { e: key.0, n: key.1, u: key.2, class: (!g) as u8, intensity: 128 });
                    }
                    if !g && (z - s.alt).abs() < 3.0 {
                        best = best.min((((x - s.e).hypot(y - s.n)) * 100.0) as u16);
                    }
                }
            }
            let sector = ((az as f64 * 2.0 / 5.0) as usize) % 72;
            if az % 3 == 0 {
                sectors[sector] = u16::MAX;
            }
            sectors[sector] = sectors[sector].min(best);
        }
        if tick % 10 == 0 && (!pending.is_empty() || first_map) {
            for chunk in pending.chunks(7000) {
                let _ = map_sock.send_to(&mapframe::encode_voxels(first_map, (home_lat, home_lon, HOME_MSL), 1.0, chunk), &args.map);
                first_map = false;
            }
            if pending.is_empty() {
                let _ = map_sock.send_to(&mapframe::encode_voxels(true, (home_lat, home_lon, HOME_MSL), 1.0, &[]), &args.map);
                first_map = false;
            }
            pending.clear();
        }
        if tick % 5 == 0 {
            let _ = map_sock.send_to(&mapframe::encode_sectors(5.0, LIDAR_RANGE as f32, &sectors), &args.map);
        }

        // ---- Entrega: o operador recoloca a carga quando o drone está no chão e desarmado ----
        for b in 0..6 {
            let ch = [5, 6, 7, 8, 10, 11][b];
            let locked = s.servo[ch - 1] != 0 && s.servo[ch - 1] < 1500;
            if !s.present[b] && locked && !s.armed && s.alt < 0.3 {
                match s.refill_at[b] {
                    None => s.refill_at[b] = Some(Instant::now() + Duration::from_secs(4)),
                    Some(t) if Instant::now() >= t => {
                        s.present[b] = true;
                        s.refill_at[b] = None;
                        s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Entrega: carga recolocada na saída {ch}"));
                    }
                    _ => {}
                }
            }
        }
        let ent_sw = (0..6).filter(|&b| s.present[b] && s.servo[[5, 6, 7, 8, 10, 11][b] - 1] < 1500).fold(0u8, |m, b| m | 1 << b);
        let servo = s.servo;

        // ---- Telemetria ----
        let (lat, lon) = to_ll(s.e, s.n);
        let boot_ms = s.boot.elapsed().as_millis() as u32;
        let texts: Vec<_> = s.texts.drain(..).collect();
        let snap = (s.armed, s.mode, s.roll, s.pitch, s.hdg, s.yaw_rate, s.alt, s.ve, s.vn, s.vz, s.current, s.used_mah, s.cur, s.mission.len());
        drop(s);
        let (armed, mode, roll, pitch, hdg, yaw_rate, alt, ve, vn, vz, current, used, cur, mlen) = snap;
        for (sev, t) in texts {
            send(MavMessage::STATUSTEXT(STATUSTEXT_DATA { severity: sev, text: t.as_str().into(), ..Default::default() }));
        }
        if tick % 10 == 0 {
            send(MavMessage::NAMED_VALUE_FLOAT(NAMED_VALUE_FLOAT_DATA { time_boot_ms: boot_ms, value: ent_sw as f32, name: "ENT_SW".into() }));
            let pwm = |i: usize| if i < 4 { if armed { 1400 } else { 1000 } } else { servo[i] };
            send(MavMessage::SERVO_OUTPUT_RAW(SERVO_OUTPUT_RAW_DATA {
                time_usec: boot_ms * 1000,
                servo1_raw: pwm(0), servo2_raw: pwm(1), servo3_raw: pwm(2), servo4_raw: pwm(3),
                servo5_raw: pwm(4), servo6_raw: pwm(5), servo7_raw: pwm(6), servo8_raw: pwm(7),
                port: 0,
                servo9_raw: pwm(8), servo10_raw: pwm(9), servo11_raw: pwm(10), servo12_raw: pwm(11),
                servo13_raw: pwm(12), servo14_raw: pwm(13), servo15_raw: pwm(14), servo16_raw: pwm(15),
            }));
        }
        if tick % 50 == 0 {
            let mut bm = MavModeFlag::MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | MavModeFlag::MAV_MODE_FLAG_STABILIZE_ENABLED;
            if armed {
                bm |= MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED;
            }
            send(MavMessage::HEARTBEAT(HEARTBEAT_DATA {
                custom_mode: mode,
                mavtype: MavType::MAV_TYPE_QUADROTOR,
                autopilot: MavAutopilot::MAV_AUTOPILOT_ARDUPILOTMEGA,
                base_mode: bm,
                system_status: if armed { MavState::MAV_STATE_ACTIVE } else { MavState::MAV_STATE_STANDBY },
                mavlink_version: 3,
            }));
            send(MavMessage::BATTERY_STATUS(BATTERY_STATUS_DATA { current_consumed: used as i32, current_battery: (current * 100.0) as i16, battery_remaining: (100.0 * (1.0 - used / 5000.0)).clamp(0.0, 100.0) as i8, ..Default::default() }));
            send(MavMessage::RADIO_STATUS(RADIO_STATUS_DATA { rssi: 200 - (lat - home_lat).abs().min(1.0) as u8, remrssi: 190, noise: 40, remnoise: 45, rxerrors: 0, fixed: 0, txbuf: 100 }));
            send(MavMessage::MISSION_CURRENT(MISSION_CURRENT_DATA { seq: if mode == 3 { cur } else { 0 }, ..Default::default() }));
            let _ = mlen;
        }
        if tick % 100 == 0 {
            send(MavMessage::HOME_POSITION(HOME_POSITION_DATA { latitude: (home_lat * 1e7) as i32, longitude: (home_lon * 1e7) as i32, altitude: (HOME_MSL * 1000.0) as i32, ..Default::default() }));
        }
        if tick % 25 == 0 {
            let soc = (1.0 - used / 5000.0).clamp(0.0, 1.0);
            let all = MavSysStatusSensor::all();
            send(MavMessage::SYS_STATUS(SYS_STATUS_DATA {
                onboard_control_sensors_present: all,
                onboard_control_sensors_enabled: all,
                onboard_control_sensors_health: all,
                load: 350,
                voltage_battery: ((6.0 * (3.45 + 0.75 * soc) - current * 0.012) * 1000.0) as u16,
                current_battery: (current * 100.0) as i16,
                battery_remaining: (soc * 100.0) as i8,
                ..Default::default()
            }));
            let vib = if armed && air { 9.0 + sp as f32 * 0.4 + rand_gauss(tick).abs() as f32 * 3.0 } else { 0.3 };
            send(MavMessage::VIBRATION(VIBRATION_DATA { vibration_x: vib, vibration_y: vib * 0.9, vibration_z: vib * 1.3, ..Default::default() }));
        }
        if tick % 10 == 0 {
            send(MavMessage::GPS_RAW_INT(GPS_RAW_INT_DATA { lat: (lat * 1e7) as i32, lon: (lon * 1e7) as i32, alt: ((HOME_MSL as f64 + alt) * 1000.0) as i32, eph: 70, epv: 110, fix_type: GpsFixType::GPS_FIX_TYPE_RTK_FIXED, satellites_visible: 16, ..Default::default() }));
            if alt < 40.0 {
                send(MavMessage::RANGEFINDER(RANGEFINDER_DATA { distance: alt as f32 + 0.12, voltage: 1.2 }));
            }
        }
        if tick % 5 == 0 {
            send(MavMessage::GLOBAL_POSITION_INT(GLOBAL_POSITION_INT_DATA {
                time_boot_ms: boot_ms,
                lat: (lat * 1e7) as i32,
                lon: (lon * 1e7) as i32,
                alt: ((HOME_MSL as f64 + alt) * 1000.0) as i32,
                relative_alt: (alt * 1000.0) as i32,
                vx: (vn * 100.0) as i16,
                vy: (ve * 100.0) as i16,
                vz: (-vz * 100.0) as i16,
                hdg: (hdg * 100.0) as u16,
            }));
            let gs = ve.hypot(vn) as f32;
            send(MavMessage::VFR_HUD(VFR_HUD_DATA { airspeed: gs, groundspeed: gs, alt: HOME_MSL + alt as f32, climb: vz as f32, heading: hdg as i16, throttle: if armed { (48.0 + vz * 6.0).clamp(0.0, 100.0) as u16 } else { 0 } }));
        }
        if tick % 2 == 0 {
            send(MavMessage::ATTITUDE(ATTITUDE_DATA { time_boot_ms: boot_ms, roll: (roll as f32).to_radians(), pitch: (pitch as f32).to_radians(), yaw: (wrap(hdg) as f32).to_radians(), rollspeed: 0.0, pitchspeed: 0.0, yawspeed: (yaw_rate as f32).to_radians() }));
        }
        if tick == 1 || tick % 1500 == 0 {
            eprintln!("[{:>5.0} s] {} {} alt {:.1} m, {} voxels mapeados", start.elapsed().as_secs_f64(), if armed { "armado" } else { "desarmado" }, modes::mode_name(mode), alt, seen.len());
        }
        std::thread::sleep(Duration::from_secs_f64(dt).saturating_sub(t0.elapsed()));
    }
}

/// Ruído pseudo-gaussiano determinístico e barato.
fn rand_gauss(seed: u64) -> f64 {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut sum = 0.0;
    for _ in 0..4 {
        x ^= x >> 33;
        x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
        sum += (x >> 11) as f64 / (1u64 << 53) as f64;
    }
    (sum - 2.0) * 1.7
}
