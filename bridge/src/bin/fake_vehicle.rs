//! Veículo simulado para testar a ponte e a interface sem SITL nem hardware.
//!
//! Fala MAVLink como um ArduPilot simplificado (modos, armar, decolar,
//! missão, parâmetros, controle manual) e envia quadros de mapa LiDAR
//! sintéticos no mesmo formato do nó `map_link` do ROS 2.
//!
//! `--vehicle` escolhe o tipo: multirrotor e helicóptero pairam (ArduCopter);
//! avião voa com velocidade mínima, faz curvas inclinado e circula para
//! "parar" (ArduPlane); VTOL paira nos modos Q e voa como avião nos demais.
//!
//! `--propulsion` escolhe o motor: elétrico (ESCs e bateria com células),
//! combustão (injeção EFI com CHT/EGT e tanque), turbina (EFI com N1, EGT e
//! sequência de partida) ou híbrido (elétrico com gerador a bordo).
//!
//!   cargo run --bin fake-vehicle
//!
//! Não substitui o SITL do ArduPilot para validar voo: a física é cinemática.
#![allow(deprecated)]

#[path = "../sim/camera.rs"]
mod camera;

use aracua_bridge::modes::VehicleClass;
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
    /// Tipo de veículo: copter (multirrotor), heli, plane (avião) ou vtol
    #[arg(long, default_value = "copter", value_parser = parse_class)]
    vehicle: VehicleClass,
    /// Motor: electric (elétrico), combustion (combustão), jet (turbina) ou hybrid (elétrico com gerador)
    #[arg(long, default_value = "electric", value_parser = parse_propulsion)]
    propulsion: Propulsion,
    /// Endereço do vídeo da câmera simulada (MJPEG em http://ENDEREÇO/video.mjpg); "off" desliga
    #[arg(long, default_value = "127.0.0.1:8090")]
    camera: String,
    /// Vento constante "DE/VELOCIDADE": de onde sopra (graus) e m/s, ex.: 270/6. Rajadas somam por cima.
    #[arg(long, default_value = "0/0", value_parser = parse_wind)]
    wind: (f64, f64),
    /// Sai quando a entrada padrão fechar (usado pelo app desktop)
    #[arg(long)]
    exit_with_parent: bool,
}

/// "270/6" → vetor do vento (leste, norte) em m/s, para onde ele empurra.
fn parse_wind(v: &str) -> Result<(f64, f64), String> {
    let (d, sp) = v.split_once('/').ok_or("use DE/VELOCIDADE, ex.: 270/6")?;
    let (d, sp): (f64, f64) = (d.trim().parse().map_err(|_| "direção inválida")?, sp.trim().parse().map_err(|_| "velocidade inválida")?);
    let r = d.to_radians();
    Ok((-sp * r.sin(), -sp * r.cos()))
}

/// Altitude do item de missão sobre o home: itens em MSL (frame GLOBAL) descontam a altitude do home.
fn rel_z(it: &MISSION_ITEM_INT_DATA) -> f64 {
    if matches!(it.frame, MavFrame::MAV_FRAME_GLOBAL | MavFrame::MAV_FRAME_GLOBAL_INT) {
        it.z as f64 - HOME_MSL as f64
    } else {
        it.z as f64
    }
}

fn parse_propulsion(s: &str) -> Result<Propulsion, String> {
    match s {
        "electric" => Ok(Propulsion::Electric),
        "combustion" => Ok(Propulsion::Combustion),
        "jet" => Ok(Propulsion::Jet),
        "hybrid" => Ok(Propulsion::Hybrid),
        _ => Err(format!("motor inválido: {s} (use electric, combustion, jet ou hybrid)")),
    }
}

fn parse_class(s: &str) -> Result<VehicleClass, String> {
    match VehicleClass::parse(s) {
        Some(VehicleClass::Rover) | None => Err(format!("tipo inválido: {s} (use copter, heli, plane ou vtol)")),
        Some(c) => Ok(c),
    }
}

const HOME_MSL: f32 = 760.0;
const G: f64 = 9.81;
/// Inclinação máxima nas curvas do avião.
const MAX_BANK_DEG: f64 = 40.0;
/// Velocidade abaixo da qual o avião perde sustentação.
const STALL_MS: f64 = 11.0;
const LIDAR_RANGE: f64 = 90.0;
/// Capacidade da bateria simulada.
const BATT_MAH: f64 = 5000.0;

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

/// Motivo da violação da geocerca por polígono/círculo, se houver (mesma regra do ArduPilot:
/// dentro de todas as áreas permitidas e fora de todas as proibidas).
fn polygon_breach(f: &aracua_bridge::fence::Fence, (lat, lon): (f64, f64)) -> Option<&'static str> {
    use aracua_bridge::fence::{inside, Point};
    let p = Point { lat, lon };
    let dist = |c: &aracua_bridge::fence::Circle| {
        let (dn, de) = ((c.lat - lat) * 111_320.0, (c.lon - lon) * 111_320.0 * lat.to_radians().cos());
        dn.hypot(de)
    };
    if f.inclusion.iter().any(|poly| !inside(p, poly)) || f.circles_inclusion.iter().any(|c| dist(c) > c.radius as f64) {
        return Some("fora da área permitida");
    }
    if f.exclusion.iter().any(|poly| inside(p, poly)) || f.circles_exclusion.iter().any(|c| dist(c) < c.radius as f64) {
        return Some("dentro de área proibida");
    }
    None
}

struct Vehicle {
    class: VehicleClass,
    /// Velocidade em relação ao ar (asa fixa).
    airspeed: f64,
    /// Centro do círculo em LOITER/GUIDED (asa fixa).
    orbit: Option<(f64, f64)>,
    /// Onde começou a perna atual da missão (para a "linha de chegada" do waypoint).
    leg_start: (f64, f64),
    /// Calibração do acelerômetro: posição pedida (1–6).
    accel_step: Option<u32>,
    /// Calibração da bússola em andamento desde.
    mag_cal: Option<Instant>,
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
    /// GUIDED do avião: rumo, ritmo de subida (0 = livre) e velocidade pedidos pelos GUIDED_CHANGE_*.
    guided_hdg: Option<f64>,
    guided_rate: f64,
    guided_speed: Option<f64>,
    /// GUIDED do multirrotor: velocidade NED, rumo e quando chegou (o ArduCopter para em 3 s sem novidade).
    guided_vel: Option<(f64, f64, f64, f64, Instant)>,
    mission: Vec<MISSION_ITEM_INT_DATA>,
    /// Geocerca recebida (itens) e já interpretada.
    fence_items: Vec<MISSION_ITEM_INT_DATA>,
    fence: aracua_bridge::fence::Fence,
    incoming: Option<(MavMissionType, u16, Vec<MISSION_ITEM_INT_DATA>)>,
    cur: u16,
    manual: (f64, f64, f64, f64, Instant),
    used_mah: f64,
    /// Corrente da bateria (A); negativa carregando.
    current: f64,
    /// Demanda do motor em ampères equivalentes (empuxo pedido), suavizada.
    load: f64,
    /// Corrente que o gerador entrega ao barramento (híbrido).
    gen_a: f64,
    propulsion: Propulsion,
    /// Inclinação do gimbal da câmera (graus; 0 = horizonte, −90 = para baixo).
    gimbal_pitch: f64,
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
    fn mode_name(&self) -> String {
        modes::mode_name(self.class, self.mode)
    }
    fn is(&self, name: &str) -> bool {
        self.mode_name() == name
    }
    /// Muda o modo pelo nome (do firmware deste veículo); ignora nomes que ele não tem.
    fn go(&mut self, name: &str) {
        if let Some(n) = modes::mode_number(self.class, name) {
            self.mode = n;
            self.enter(name);
        }
    }
    /// Efeitos de entrar num modo: alvo de altitude, círculo novo, missão do começo.
    fn enter(&mut self, name: &str) {
        self.orbit = None;
        match name {
            "AUTO" => self.cur = 1,
            "GUIDED" => {
                self.guided_target = None;
                self.guided_hdg = None;
                self.guided_rate = 0.0;
                self.guided_speed = None;
                self.guided_vel = None;
                self.target_alt = self.alt;
            }
            "LOITER" | "CIRCLE" | "CRUISE" | "FBWB" => self.target_alt = self.alt,
            "TAKEOFF" => self.target_alt = self.params.get("TKOFF_ALT").copied().unwrap_or(50.0) as f64,
            _ => {}
        }
    }
    /// Modos de pairar com o nome do multirrotor; no VTOL viram os modos Q.
    fn go_hover(&mut self, name: &str) {
        let q = match (self.class, name) {
            (VehicleClass::Vtol, "LAND") => "QLAND",
            (VehicleClass::Vtol, "RTL") => "QRTL",
            (VehicleClass::Vtol, "LOITER") => "QLOITER",
            _ => name,
        };
        self.go(q);
    }
    /// Item da missão em execução (em AUTO).
    fn current_cmd(&self) -> Option<MavCmd> {
        if self.is("AUTO") { self.mission.get(self.cur as usize).map(|i| i.command) } else { None }
    }
    /// Este instante usa a física de pairar (multirrotor, helicóptero, VTOL em modo Q,
    /// na decolagem vertical ou nos itens VTOL da missão)?
    fn hovering(&self) -> bool {
        match self.class {
            VehicleClass::Plane => false,
            VehicleClass::Vtol => {
                let m = self.mode_name();
                m.starts_with('Q')
                    || (m == "TAKEOFF" && self.alt < self.target_alt - 0.5)
                    || matches!(self.current_cmd(), Some(MavCmd::MAV_CMD_NAV_VTOL_TAKEOFF | MavCmd::MAV_CMD_NAV_VTOL_LAND))
            }
            _ => true,
        }
    }
    /// Nome equivalente do modo para a física de pairar (VTOL: QLOITER → LOITER…).
    fn hover_mode(&self) -> String {
        let m = self.mode_name();
        match m.as_str() {
            "QHOVER" | "QSTABILIZE" | "QACRO" => "ALT_HOLD".into(),
            "QLOITER" => "LOITER".into(),
            "QLAND" => "LAND".into(),
            "QRTL" => "RTL".into(),
            "TAKEOFF" => "GUIDED".into(),
            _ => m,
        }
    }
    fn say(&mut self, sev: MavSeverity, t: impl Into<String>) {
        self.texts.push((sev, t.into()));
    }
    /// MAV_CMD_DO_SET_SERVO: move a saída; se for um compartimento e o pino abrir, a carga cai.
    fn set_servo(&mut self, ch: usize, pwm: u16) -> bool {
        if !(1..=16).contains(&ch) || (1..=4).contains(&ch) {
            return false;
        }
        self.servo[ch - 1] = pwm;
        if let Some(b) = switch_bit(ch)
            && pwm >= 1500 && self.present[b] {
                self.present[b] = false;
                self.refill_at[b] = None;
                let alt = self.alt;
                self.say(MavSeverity::MAV_SEVERITY_INFO, format!("Entrega: carga da saída {ch} solta a {alt:.1} m"));
            }
        true
    }
    fn set_mode(&mut self, m: u32) -> bool {
        let name = modes::mode_name(self.class, m);
        if name.starts_with("MODE_") {
            return false;
        }
        if self.class == VehicleClass::Plane && name.starts_with('Q') {
            self.say(MavSeverity::MAV_SEVERITY_WARNING, "Modo Q exige um VTOL (Q_ENABLE)");
            return false;
        }
        if name == "AUTO" && self.mission.len() < 2 {
            self.say(MavSeverity::MAV_SEVERITY_WARNING, "Mission: nenhuma missão carregada");
            return false;
        }
        self.mode = m;
        self.enter(&name);
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
    let to_ll = move |e: f64, n: f64| (home_lat + n / 111_320.0, home_lon + e / (111_320.0 * (home_lat * PI / 180.0).cos()));
    let to_en = move |lat: f64, lon: f64| ((lon - home_lon) * 111_320.0 * (home_lat * PI / 180.0).cos(), (lat - home_lat) * 111_320.0);

    let class = args.vehicle;
    let common: &[(&str, f32)] = &[
        ("FENCE_ENABLE", 1.0), ("FENCE_RADIUS", 400.0), ("FENCE_ACTION", 1.0), ("FENCE_TYPE", 7.0),
        ("BATT_LOW_MAH", 750.0), ("BATT_FS_LOW_ACT", 2.0), ("FS_GCS_ENABLE", 1.0),
        ("AVOID_ENABLE", 7.0), ("AVOID_DIST_MAX", 9.0),
    ];
    // Parâmetros com os nomes de cada firmware.
    let specific: &[(&str, f32)] = if class.fixed_wing() {
        &[
            ("AIRSPEED_CRUISE", 18.0), ("AIRSPEED_MIN", 12.0), ("TKOFF_ALT", 50.0), ("RTL_ALTITUDE", 80.0),
            ("WP_RADIUS", 30.0), ("WP_LOITER_RAD", 70.0), ("FENCE_RADIUS", 1500.0),
            ("Q_ENABLE", if class == VehicleClass::Vtol { 1.0 } else { 0.0 }),
            ("Q_WP_SPEED", 500.0), ("Q_RTL_ALT", 3000.0),
        ]
    } else {
        &[("RTL_ALT", 3000.0), ("WPNAV_SPEED", 900.0), ("LOIT_SPEED", 1200.0), ("PILOT_SPEED_UP", 400.0), ("PILOT_TKOFF_ALT", 4200.0)]
    };
    let params: HashMap<String, f32> = common.iter().chain(specific).map(|(k, v)| (k.to_string(), *v)).collect();
    let start_mode = match class {
        VehicleClass::Plane => "MANUAL",
        VehicleClass::Vtol => "QLOITER",
        _ => "LOITER",
    };

    let v = Arc::new(Mutex::new(Vehicle {
        class, airspeed: 0.0, orbit: None, leg_start: (0.0, 0.0), accel_step: None, mag_cal: None,
        e: 0.0, n: 0.0, alt: 0.0, ve: 0.0, vn: 0.0, vz: 0.0, hdg: 48.0, roll: 0.0, pitch: 0.0, yaw_rate: 0.0,
        armed: false, mode: modes::mode_number(class, start_mode).unwrap_or(0), target_alt: 0.0, guided_target: None, guided_hdg: None, guided_rate: 0.0, guided_speed: None, guided_vel: None, mission: vec![], fence_items: vec![], fence: Default::default(), incoming: None, cur: 0,
        manual: (0.0, 0.0, 0.5, 0.0, Instant::now()), used_mah: 0.0, current: 0.0, load: 0.0, gen_a: 0.0, propulsion: args.propulsion, gimbal_pitch: -30.0, landed_t: 0.0, params,
        texts: vec![], boot: Instant::now(), servo: [0; 16], relay: [false; 8],
        present: [true, true, true, true, false, false], refill_at: [None; 6], loiter_until: None,
    }));
    let firmware = match class {
        VehicleClass::Copter => "ArduCopter simulado (multirrotor)",
        VehicleClass::Heli => "ArduCopter simulado (helicóptero)",
        VehicleClass::Plane => "ArduPlane simulado (avião)",
        VehicleClass::Vtol => "ArduPlane simulado (VTOL / QuadPlane)",
        VehicleClass::Rover => "ArduRover simulado",
    };
    v.lock().unwrap().say(MavSeverity::MAV_SEVERITY_INFO, format!("{firmware} pronto"));
    eprintln!("{firmware}: MAVLink em {}, mapa em {}", args.mavlink, args.map);

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
                // Comandos do piloto automático do avião (ArduPlane 4.5+): só valem em GUIDED.
                MavMessage::COMMAND_INT(c) if matches!(c.command, MavCmd::MAV_CMD_GUIDED_CHANGE_HEADING | MavCmd::MAV_CMD_GUIDED_CHANGE_ALTITUDE | MavCmd::MAV_CMD_GUIDED_CHANGE_SPEED) => {
                    let ok = s.class.fixed_wing() && s.is("GUIDED");
                    if ok {
                        match c.command {
                            MavCmd::MAV_CMD_GUIDED_CHANGE_HEADING => s.guided_hdg = Some(c.param2 as f64),
                            MavCmd::MAV_CMD_GUIDED_CHANGE_ALTITUDE => {
                                s.target_alt = c.z as f64;
                                s.guided_rate = c.param3.max(0.0) as f64;
                            }
                            _ => s.guided_speed = (c.param2 > 0.0).then_some(c.param2 as f64),
                        }
                    }
                    drop(s);
                    ack(&send, c.command, ok);
                    continue;
                }
                // Desvio (DO_REPOSITION): vai para o ponto em GUIDED, na altura pedida.
                MavMessage::COMMAND_INT(c) if c.command == MavCmd::MAV_CMD_DO_REPOSITION => {
                    let ok = s.armed && s.alt > 1.0 && c.frame == MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT_INT;
                    if ok {
                        if (c.param2 as u32) & 1 == 1 && !s.is("GUIDED") {
                            s.go("GUIDED");
                        }
                        s.guided_target = Some(to_en(c.x as f64 / 1e7, c.y as f64 / 1e7));
                        s.guided_hdg = None;
                        s.target_alt = c.z as f64;
                        s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reposicionando para {:.5}, {:.5}", c.x as f64 / 1e7, c.y as f64 / 1e7));
                    }
                    drop(s);
                    ack(&send, c.command, ok);
                    continue;
                }
                MavMessage::MISSION_SET_CURRENT(m) => {
                    if m.seq > 0 && (m.seq as usize) < s.mission.len() {
                        s.cur = m.seq;
                        s.leg_start = (s.e, s.n);
                        s.loiter_until = None;
                        s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Missão: indo para o item {}", m.seq));
                    }
                }
                MavMessage::SET_POSITION_TARGET_LOCAL_NED(t) => {
                    if !s.class.fixed_wing() && s.is("GUIDED") {
                        s.guided_vel = Some((t.vx as f64, t.vy as f64, t.vz as f64, (t.yaw as f64).to_degrees(), Instant::now()));
                    }
                }
                MavMessage::COMMAND_LONG(c) => match c.command {
                    MavCmd::MAV_CMD_COMPONENT_ARM_DISARM => {
                        let arm = c.param1 > 0.5;
                        let ok = if arm {
                            // O ArduCopter só arma em modos de pilotagem; o ArduPlane arma em quase todos.
                            let armable = s.class.fixed_wing()
                                || ["STABILIZE", "ALT_HOLD", "GUIDED", "LOITER", "POSHOLD"].contains(&s.mode_name().as_str());
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
                        let ok = s.armed && s.is("GUIDED") && s.alt < 1.0 && !s.class.fixed_wing();
                        if ok {
                            s.target_alt = c.param7 as f64;
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Decolando para {:.0} m", c.param7));
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_MISSION_START => {
                        let ok = s.armed && s.mission.len() > 1;
                        if ok {
                            s.go("AUTO");
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
                    MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION => {
                        let ok = !s.armed;
                        if ok && c.param5 == 1.0 {
                            s.accel_step = Some(1);
                            s.say(MavSeverity::MAV_SEVERITY_INFO, "Place vehicle level and press any key.");
                            send_accel_pos(&send, 1);
                        } else if ok && c.param5 == 2.0 {
                            s.say(MavSeverity::MAV_SEVERITY_INFO, "Trim OK: roll=0.21 pitch=-0.35");
                        } else if ok && c.param1 == 1.0 {
                            s.say(MavSeverity::MAV_SEVERITY_INFO, "Gyro calibration complete");
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS => {
                        if let Some(step) = s.accel_step.filter(|st| *st == c.param1 as u32) {
                            if step >= 6 {
                                s.accel_step = None;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, "Calibration successful");
                                send_accel_pos(&send, 16_777_215);
                            } else {
                                s.accel_step = Some(step + 1);
                                let place = ["", "level", "on its LEFT side", "on its RIGHT side", "nose DOWN", "nose UP", "on its BACK"][step as usize + 1];
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Place vehicle {place} and press any key."));
                                send_accel_pos(&send, step + 1);
                            }
                        }
                    }
                    MavCmd::MAV_CMD_DO_START_MAG_CAL => {
                        let ok = !s.armed;
                        if ok {
                            s.mag_cal = Some(Instant::now());
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_CANCEL_MAG_CAL => {
                        s.mag_cal = None;
                        s.say(MavSeverity::MAV_SEVERITY_INFO, "Mag calibration cancelled");
                        ack(&send, c.command, true);
                    }
                    MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN => {
                        let ok = !s.armed;
                        if ok {
                            s.say(MavSeverity::MAV_SEVERITY_WARNING, "Reiniciando (simulado)");
                        }
                        ack(&send, c.command, ok);
                    }
                    MavCmd::MAV_CMD_DO_DIGICAM_CONTROL => {
                        s.say(MavSeverity::MAV_SEVERITY_INFO, "Câmera: foto capturada");
                        ack(&send, c.command, true)
                    }
                    MavCmd::MAV_CMD_DO_MOUNT_CONTROL => {
                        s.gimbal_pitch = (c.param1 as f64).clamp(-90.0, 30.0);
                        ack(&send, c.command, true);
                    }
                    _ => ack(&send, c.command, true),
                },
                MavMessage::MANUAL_CONTROL(m) => {
                    s.manual = (m.x as f64 / 1000.0, m.y as f64 / 1000.0, m.z as f64 / 1000.0, m.r as f64 / 1000.0, Instant::now());
                }
                // Protocolo de missão: missão comum e geocerca (mission_type FENCE).
                MavMessage::MISSION_COUNT(c) => {
                    let mt = c.mission_type;
                    if c.count == 0 {
                        match mt {
                            MavMissionType::MAV_MISSION_TYPE_FENCE => {
                                s.fence_items.clear();
                                s.fence = Default::default();
                            }
                            _ => s.mission.clear(),
                        }
                        send(MavMessage::MISSION_ACK(MISSION_ACK_DATA { target_system: 255, target_component: 190, mavtype: MavMissionResult::MAV_MISSION_ACCEPTED, mission_type: mt, ..Default::default() }));
                    } else {
                        s.incoming = Some((mt, c.count, vec![]));
                        send(MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA { seq: 0, target_system: 255, target_component: 190, mission_type: mt }));
                    }
                }
                MavMessage::MISSION_ITEM_INT(it) => {
                    if let Some((mt, count, mut items)) = s.incoming.take() {
                        if it.seq as usize == items.len() && it.mission_type == mt {
                            items.push(it);
                        }
                        if items.len() as u16 == count {
                            let n = items.len();
                            if mt == MavMissionType::MAV_MISSION_TYPE_FENCE {
                                s.fence = aracua_bridge::fence::Fence::parse(&items);
                                s.fence_items = items;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Geocerca recebida: {} itens", n));
                            } else {
                                s.mission = items;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Missão recebida: {} itens", n));
                            }
                            send(MavMessage::MISSION_ACK(MISSION_ACK_DATA { target_system: 255, target_component: 190, mavtype: MavMissionResult::MAV_MISSION_ACCEPTED, mission_type: mt, ..Default::default() }));
                        } else {
                            let next = items.len() as u16;
                            s.incoming = Some((mt, count, items));
                            send(MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA { seq: next, target_system: 255, target_component: 190, mission_type: mt }));
                        }
                    }
                }
                MavMessage::MISSION_REQUEST_LIST(r) => {
                    let n = if r.mission_type == MavMissionType::MAV_MISSION_TYPE_FENCE { s.fence_items.len() } else { s.mission.len() };
                    send(MavMessage::MISSION_COUNT(MISSION_COUNT_DATA { count: n as u16, target_system: 255, target_component: 190, mission_type: r.mission_type, ..Default::default() }));
                }
                MavMessage::MISSION_REQUEST_INT(r) if s.incoming.is_none() => {
                    let list = if r.mission_type == MavMissionType::MAV_MISSION_TYPE_FENCE { &s.fence_items } else { &s.mission };
                    if let Some(it) = list.get(r.seq as usize) {
                        send(MavMessage::MISSION_ITEM_INT(MISSION_ITEM_INT_DATA { target_system: 255, target_component: 190, mission_type: r.mission_type, ..it.clone() }));
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
    let mut engine = Engine::new(args.propulsion, class);
    // Câmera: o mesmo bairro do LiDAR, vista do drone.
    if args.camera != "off" {
        let bus = Arc::new(camera::Bus::default());
        match camera::serve(&args.camera, bus.clone()) {
            Ok(()) => {
                eprintln!("câmera simulada em http://{}/video.mjpg", args.camera);
                let blocks = boxes.iter().map(|b| camera::Block { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, h: b.h }).collect();
                let v = v.clone();
                camera::run(blocks, bus, move || {
                    let s = v.lock().unwrap();
                    // Câmera embaixo do veículo, olhando para a frente dele.
                    camera::Pose { e: s.e, n: s.n, alt: s.alt + 0.15, hdg: s.hdg, pitch: s.gimbal_pitch }
                });
            }
            Err(e) => eprintln!("câmera simulada desligada: {} ({e})", args.camera),
        }
    }
    loop {
        let t0 = Instant::now();
        tick += 1;
        let mut s = v.lock().unwrap();
        let params = s.params.clone();
        let p = |k: &str, d: f32| params.get(k).copied().unwrap_or(d) as f64;
        let (wp_speed, loit_speed, climb, rtl_alt) = (p("WPNAV_SPEED", 900.0) / 100.0, p("LOIT_SPEED", 1200.0) / 100.0, p("PILOT_SPEED_UP", 400.0) / 100.0, p("RTL_ALT", 3000.0) / 100.0);
        let fence = (p("FENCE_ENABLE", 1.0) > 0.5, p("FENCE_RADIUS", 400.0));
        let fence_poly = fence.0 && (p("FENCE_TYPE", 7.0) as u32) & 4 != 0;
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
        if s.hovering() {
            if s.armed {
                let (mx, my, mz, mr, mt) = s.manual;
                let fresh = mt.elapsed() < Duration::from_millis(600);
                match s.hover_mode().as_str() {
                    "LOITER" | "POSHOLD" | "ALT_HOLD" | "STABILIZE" => {
                        if fresh {
                            let (fw, rt) = (mx * loit_speed, my * loit_speed);
                            de = fx * fw + fy * rt;
                            dn = fy * fw - fx * rt;
                            dz = (mz - 0.5) * 2.0 * climb;
                            dyaw = mr * 80.0;
                        }
                    }
                    "GUIDED" => match s.guided_vel {
                        Some((vn, ve, vd, yaw, at)) if at.elapsed() < Duration::from_secs(3) => {
                            (de, dn, dz) = (ve, vn, -vd);
                            dyaw = (wrap(yaw - s.hdg) * 1.5).clamp(-90.0, 90.0);
                            s.target_alt = s.alt;
                        }
                        // Sem alvo novo há 3 s: para onde está, como o ArduCopter.
                        Some(_) => {
                            s.guided_vel = None;
                            s.guided_target = Some((s.e, s.n));
                        }
                        None => {
                            let (te, tn) = s.guided_target.unwrap_or((s.e, s.n));
                            let ta = s.target_alt;
                            (de, dn, dz, dyaw, _) = goto(&s, te, tn, ta, wp_speed);
                        }
                    },
                    "AUTO" => {
                        let idx = s.cur as usize;
                        match s.mission.get(idx).cloned() {
                            Some(it) if it.command == MavCmd::MAV_CMD_DO_LAND_START => s.cur += 1,
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_LAND || it.command == MavCmd::MAV_CMD_NAV_VTOL_LAND => {
                            // Vai até o ponto na altura atual e desce na vertical.
                            let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                            let (a, b, _, y, d) = goto(&s, te, tn, s.alt, wp_speed);
                            (de, dn, dyaw) = (a, b, y);
                            dz = if d > 3.0 { 0.0 } else if s.alt > 6.0 { -2.0 } else { -0.7 };
                        }
                        Some(it) if it.command == MavCmd::MAV_CMD_NAV_TAKEOFF || it.command == MavCmd::MAV_CMD_NAV_VTOL_TAKEOFF => {
                                dz = ((rel_z(&it) - s.alt) * 0.9).clamp(0.4, 3.5);
                                if s.alt >= rel_z(&it) - 0.5 {
                                    s.cur += 1;
                                    s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                                }
                            }
                            Some(it) if it.command == MavCmd::MAV_CMD_NAV_WAYPOINT => {
                                let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                                let d;
                                (de, dn, dz, dyaw, d) = goto(&s, te, tn, rel_z(&it), wp_speed);
                                if d < 2.0 && (s.alt - rel_z(&it)).abs() < 1.5 {
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
                                (de, dn, dz, dyaw, d) = goto(&s, te, tn, rel_z(&it), wp_speed);
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
                                s.go_hover("RTL");
                            }
                            // Paira sobre o ponto sem fim (voo só de ida), continuando em AUTO.
                            Some(it) if it.command == MavCmd::MAV_CMD_NAV_LOITER_UNLIM => {
                                let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                                (de, dn, dz, dyaw, _) = goto(&s, te, tn, rel_z(&it), wp_speed);
                            }
                            _ => {
                                s.go_hover("LOITER");
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
                                s.go_hover("LAND");
                            }
                        }
                    }
                    "LAND" => dz = if s.alt > 6.0 { -2.0 } else { -0.7 },
                    _ => {}
                }
                if s.hover_mode() == "GUIDED" && s.alt < 0.3 && s.target_alt < 0.5 {
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
                wind.0 += (args.wind.0 + rand_gauss(tick) * 1.2 - wind.0) * dt * 0.8;
                wind.1 += (args.wind.1 + rand_gauss(tick + 7) * 1.2 - wind.1) * dt * 0.8;
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
            let landing_item = matches!(s.current_cmd(), Some(MavCmd::MAV_CMD_NAV_LAND | MavCmd::MAV_CMD_NAV_VTOL_LAND));
        if s.armed && s.alt < 0.05 && (["LAND", "RTL"].contains(&s.hover_mode().as_str()) || landing_item) {
                s.landed_t += dt;
                if s.landed_t > 1.5 {
                    s.armed = false;
                    s.go_hover("LOITER");
                    s.say(MavSeverity::MAV_SEVERITY_INFO, "Pouso concluído, motores desarmados");
                }
            }
        } else {
            fixed_wing_step(&mut s, dt, &p, &to_en, &mut wind, args.wind, tick);
        }
        let air = s.alt > 0.15;
        let sp = s.ve.hypot(s.vn);
        let demand = if !s.armed {
            0.4
        } else if !s.hovering() {
            // asa fixa: o motor só empurra; a corrente cresce com a velocidade e a subida
            if air || s.airspeed > 1.0 { 7.0 + s.airspeed * 0.45 + s.vz.max(0.0) * 3.0 } else { 1.5 }
        } else if air {
            16.0 + sp * 0.9 + s.vz.max(0.0) * 5.0
        } else {
            2.2
        };
        s.load += (demand - s.load) * 0.05;
        // Motor a combustível: a bateria só alimenta a aviônica. Híbrido: o gerador ajuda.
        s.current = if s.propulsion.burns_fuel() { if s.armed { 2.4 } else { 0.8 } } else { s.load } - s.gen_a;
        s.used_mah = (s.used_mah + s.current * dt / 3.6).max(0.0);
        let soc = (1.0 - s.used_mah / BATT_MAH).clamp(0.0, 1.0);
        let returning = ["RTL", "LAND", "QRTL", "QLAND"].contains(&s.mode_name().as_str());
        if fence.0 && air && s.e.hypot(s.n) > fence.1 && !returning {
            s.go("RTL");
            s.say(MavSeverity::MAV_SEVERITY_CRITICAL, "Geocerca violada: RTL");
        }
        if fence_poly && air && !returning {
            if let Some(why) = polygon_breach(&s.fence, to_ll(s.e, s.n)) {
                s.go("RTL");
                s.say(MavSeverity::MAV_SEVERITY_CRITICAL, format!("Geocerca violada ({why}): RTL"));
            }
        }
        if air && soc * BATT_MAH < p("BATT_LOW_MAH", 750.0) && !returning {
            s.go("RTL");
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
            if az.is_multiple_of(3) {
                sectors[sector] = u16::MAX;
            }
            sectors[sector] = sectors[sector].min(best);
        }
        if tick.is_multiple_of(10) && (!pending.is_empty() || first_map) {
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
        if tick.is_multiple_of(5) {
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
        let texts: Vec<_> = std::mem::take(&mut s.texts);
        let airspeed = if s.hovering() { s.ve.hypot(s.vn) } else { s.airspeed };
        let snap = (s.armed, s.mode, s.roll, s.pitch, s.hdg, s.yaw_rate, s.alt, s.ve, s.vn, s.vz, s.current, s.used_mah, s.cur, s.mission.len());
        let (load, hovering) = (s.load, s.hovering());
        drop(s);
        let (armed, mode, roll, pitch, hdg, yaw_rate, alt, ve, vn, vz, current, used, cur, mlen) = snap;
        // ---- Motor e energia ----
        let soc = (1.0 - used / BATT_MAH).clamp(0.0, 1.0);
        let cells = engine.cells(soc, current);
        let pack_v: f64 = cells.iter().sum();
        let (gen_a, note) = engine.step(dt, armed, load, hovering, current, pack_v);
        {
            let mut s = v.lock().unwrap();
            s.gen_a = gen_a;
            if let Some(t) = note {
                s.say(MavSeverity::MAV_SEVERITY_CRITICAL, t);
            }
        }
        if tick.is_multiple_of(10) {
            for m in engine.messages(boot_ms, &cells, current, used, soc, tick.is_multiple_of(25)) {
                send(m);
            }
        }
        for (sev, t) in texts {
            send(MavMessage::STATUSTEXT(STATUSTEXT_DATA { severity: sev, text: t.as_str().into(), ..Default::default() }));
        }
        if tick.is_multiple_of(10) {
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
        if tick.is_multiple_of(50) {
            let mut bm = MavModeFlag::MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | MavModeFlag::MAV_MODE_FLAG_STABILIZE_ENABLED;
            if armed {
                bm |= MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED;
            }
            send(MavMessage::HEARTBEAT(HEARTBEAT_DATA {
                custom_mode: mode,
                mavtype: class.mav_type(),
                autopilot: MavAutopilot::MAV_AUTOPILOT_ARDUPILOTMEGA,
                base_mode: bm,
                system_status: if armed { MavState::MAV_STATE_ACTIVE } else { MavState::MAV_STATE_STANDBY },
                mavlink_version: 3,
            }));
            send(MavMessage::RADIO_STATUS(RADIO_STATUS_DATA { rssi: 200 - (lat - home_lat).abs().min(1.0) as u8, remrssi: 190, noise: 40, remnoise: 45, rxerrors: 0, fixed: 0, txbuf: 100 }));
            let auto = modes::mode_name(class, mode) == "AUTO";
            send(MavMessage::MISSION_CURRENT(MISSION_CURRENT_DATA { seq: if auto { cur } else { 0 }, ..Default::default() }));
            let _ = mlen;
        }
        if tick.is_multiple_of(10) {
            // Rádio: sticks do controle manual (ou centrados), acelerador no mínimo.
            let (mx, my, mz, mr, mt) = v.lock().unwrap().manual;
            let fresh = mt.elapsed() < Duration::from_millis(600);
            let pwm = |x: f64| (1500.0 + x.clamp(-1.0, 1.0) * 400.0) as u16 + (rand_gauss(tick) * 2.0) as u16;
            let (roll, pitch, thr, yaw) = if fresh { (pwm(my), pwm(-mx), (1100.0 + mz * 800.0) as u16, pwm(mr)) } else { (pwm(0.0), pwm(0.0), 1100, pwm(0.0)) };
            send(MavMessage::RC_CHANNELS(RC_CHANNELS_DATA {
                time_boot_ms: boot_ms, chancount: 8, rssi: 220,
                chan1_raw: roll, chan2_raw: pitch, chan3_raw: thr, chan4_raw: yaw,
                chan5_raw: 1100, chan6_raw: 1500, chan7_raw: 1100, chan8_raw: 1900,
                ..Default::default()
            }));
            // Calibração da bússola: ~8 s girando o veículo.
            let mag = v.lock().unwrap().mag_cal;
            if let Some(t0) = mag {
                let pct = (t0.elapsed().as_secs_f64() / 8.0 * 100.0).min(100.0) as u8;
                if pct < 100 {
                    send(MavMessage::MAG_CAL_PROGRESS(MAG_CAL_PROGRESS_DATA {
                        compass_id: 0, cal_mask: 1, attempt: 1, completion_pct: pct,
                        cal_status: if pct < 50 { MagCalStatus::MAG_CAL_RUNNING_STEP_ONE } else { MagCalStatus::MAG_CAL_RUNNING_STEP_TWO },
                        ..Default::default()
                    }));
                } else {
                    let mut st = v.lock().unwrap();
                    st.mag_cal = None;
                    st.say(MavSeverity::MAV_SEVERITY_INFO, "Compass calibration complete, reboot required");
                    drop(st);
                    send(MavMessage::MAG_CAL_REPORT(MAG_CAL_REPORT_DATA {
                        compass_id: 0, cal_mask: 1, cal_status: MagCalStatus::MAG_CAL_SUCCESS, autosaved: 1,
                        fitness: 9.4, ofs_x: 31.0, ofs_y: -12.0, ofs_z: 44.0, diag_x: 1.0, diag_y: 1.0, diag_z: 1.0, scale_factor: 1.0,
                        ..Default::default()
                    }));
                }
            }
        }
        if tick.is_multiple_of(100) {
            send(MavMessage::HOME_POSITION(HOME_POSITION_DATA { latitude: (home_lat * 1e7) as i32, longitude: (home_lon * 1e7) as i32, altitude: (HOME_MSL * 1000.0) as i32, ..Default::default() }));
        }
        if tick.is_multiple_of(50) {
            // Vento estimado (o ArduPilot manda WIND): de onde sopra, como o firmware.
            let w = if alt > 1.0 { wind } else { args.wind };
            let speed = w.0.hypot(w.1);
            let dir = if speed < 0.05 { 0.0 } else { (-w.0).atan2(-w.1).to_degrees().rem_euclid(360.0) };
            send(MavMessage::WIND(WIND_DATA { direction: dir as f32, speed: speed as f32, speed_z: 0.0 }));
        }
        if tick.is_multiple_of(25) {
            let all = MavSysStatusSensor::all();
            send(MavMessage::SYS_STATUS(SYS_STATUS_DATA {
                onboard_control_sensors_present: all,
                onboard_control_sensors_enabled: all,
                onboard_control_sensors_health: all,
                load: 350,
                voltage_battery: (pack_v * 1000.0) as u16,
                current_battery: (current * 100.0) as i16,
                battery_remaining: (soc * 100.0) as i8,
                ..Default::default()
            }));
            let vib = if armed && air { 9.0 + sp as f32 * 0.4 + rand_gauss(tick).abs() as f32 * 3.0 } else { 0.3 };
            send(MavMessage::VIBRATION(VIBRATION_DATA { vibration_x: vib, vibration_y: vib * 0.9, vibration_z: vib * 1.3, ..Default::default() }));
        }
        if tick.is_multiple_of(10) {
            send(MavMessage::GPS_RAW_INT(GPS_RAW_INT_DATA { lat: (lat * 1e7) as i32, lon: (lon * 1e7) as i32, alt: ((HOME_MSL as f64 + alt) * 1000.0) as i32, eph: 70, epv: 110, fix_type: GpsFixType::GPS_FIX_TYPE_RTK_FIXED, satellites_visible: 16, ..Default::default() }));
            if alt < 40.0 {
                send(MavMessage::RANGEFINDER(RANGEFINDER_DATA { distance: alt as f32 + 0.12, voltage: 1.2 }));
            }
        }
        if tick.is_multiple_of(5) {
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
            send(MavMessage::VFR_HUD(VFR_HUD_DATA { airspeed: airspeed as f32, groundspeed: gs, alt: HOME_MSL + alt as f32, climb: vz as f32, heading: hdg as i16, throttle: if armed { (48.0 + vz * 6.0).clamp(0.0, 100.0) as u16 } else { 0 } }));
        }
        if tick.is_multiple_of(2) {
            send(MavMessage::ATTITUDE(ATTITUDE_DATA { time_boot_ms: boot_ms, roll: (roll as f32).to_radians(), pitch: (pitch as f32).to_radians(), yaw: (wrap(hdg) as f32).to_radians(), rollspeed: 0.0, pitchspeed: 0.0, yawspeed: (yaw_rate as f32).to_radians() }));
        }
        if tick == 1 || tick.is_multiple_of(1500) {
            eprintln!("[{:>5.0} s] {} {} alt {:.1} m, {} voxels mapeados", start.elapsed().as_secs_f64(), if armed { "armado" } else { "desarmado" }, modes::mode_name(class, mode), alt, seen.len());
        }
        std::thread::sleep(Duration::from_secs_f64(dt).saturating_sub(t0.elapsed()));
    }
}

/// A controladora pede uma posição da calibração do acelerômetro com um COMMAND_LONG para a estação.
fn send_accel_pos(send: &impl Fn(MavMessage), pos: u32) {
    send(MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
        param1: pos as f32,
        command: MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS,
        target_system: 255,
        target_component: 190,
        ..Default::default()
    }));
}

/// Física de asa fixa: precisa de velocidade para voar, muda de rumo inclinando
/// (taxa de curva = g·tan(inclinação)/v) e "para" circulando. Passa por cima dos prédios.
fn fixed_wing_step(
    s: &mut Vehicle,
    dt: f64,
    p: &dyn Fn(&str, f32) -> f64,
    to_en: &dyn Fn(f64, f64) -> (f64, f64),
    wind: &mut (f64, f64),
    steady: (f64, f64),
    tick: u64,
) {
    let cruise = p("AIRSPEED_CRUISE", 18.0).max(STALL_MS + 3.0);
    let radius = p("WP_LOITER_RAD", 70.0).abs().max(25.0);
    let wp_radius = p("WP_RADIUS", 30.0).max(5.0);
    let rtl_alt = p("RTL_ALTITUDE", 80.0);
    let mode = s.mode_name();
    let (mx, my, mz, _, mt) = s.manual;
    let fresh = mt.elapsed() < Duration::from_millis(600);
    let on_ground = s.alt < 0.2;

    let bearing = |s: &Vehicle, e: f64, n: f64| (e - s.e).atan2(n - s.n).to_degrees().rem_euclid(360.0);
    // Rumo que mantém um círculo no sentido horário de raio r em torno de (ce, cn).
    let orbit_hdg = |s: &Vehicle, (ce, cn): (f64, f64), r: f64| {
        let d = (s.e - ce).hypot(s.n - cn).max(0.1);
        let radial = (s.e - ce).atan2(s.n - cn).to_degrees();
        let corr = ((d - r) / r * 70.0).clamp(-70.0, 70.0);
        (radial + 90.0 + corr).rem_euclid(360.0)
    };
    // Centro de um círculo que começa à direita do avião, para entrar nele suavemente.
    let right_center = |s: &Vehicle, r: f64| {
        let h = (s.hdg + 90.0).to_radians();
        (s.e + h.sin() * r, s.n + h.cos() * r)
    };

    let mut bank_cmd: Option<f64> = None;
    let mut target_hdg: Option<f64> = None;
    let mut target_alt = s.target_alt;
    let mut target_speed = cruise;
    let mut climb_cmd: Option<f64> = None;
    let mut takeoff_roll = false;

    if s.armed {
        match mode.as_str() {
            "MANUAL" | "STABILIZE" | "FBWA" | "ACRO" | "TRAINING" => {
                bank_cmd = Some(if fresh { my * MAX_BANK_DEG } else { 0.0 });
                climb_cmd = Some(if fresh { -mx * 6.0 } else { 0.0 });
                if fresh {
                    target_speed = (STALL_MS + 1.0) + mz * (cruise * 1.4 - STALL_MS - 1.0);
                }
                takeoff_roll = on_ground && fresh && mz > 0.6;
            }
            "FBWB" | "CRUISE" => {
                bank_cmd = Some(if fresh { my * MAX_BANK_DEG } else { 0.0 });
                if fresh {
                    s.target_alt = (s.target_alt - mx * 4.0 * dt).max(5.0);
                }
                target_alt = s.target_alt;
            }
            "TAKEOFF" => {
                bank_cmd = Some(0.0);
                takeoff_roll = true;
                climb_cmd = Some(if s.airspeed > STALL_MS + 1.0 { 4.0 } else { 0.0 });
                if !on_ground && s.alt >= s.target_alt - 1.0 {
                    s.go("LOITER");
                    s.say(MavSeverity::MAV_SEVERITY_INFO, "Decolagem concluída, circulando");
                }
            }
            "GUIDED" if s.guided_hdg.is_some() => {
                target_hdg = s.guided_hdg;
                target_speed = s.guided_speed.unwrap_or(cruise);
                if s.guided_rate > 0.0 {
                    climb_cmd = Some(((s.target_alt - s.alt) * 0.35).clamp(-s.guided_rate, s.guided_rate));
                }
            }
            "LOITER" | "CIRCLE" | "GUIDED" => {
                if mode == "GUIDED" {
                    target_speed = s.guided_speed.unwrap_or(cruise);
                    if s.guided_rate > 0.0 {
                        climb_cmd = Some(((s.target_alt - s.alt) * 0.35).clamp(-s.guided_rate, s.guided_rate));
                    }
                }
                let c = match (mode.as_str(), s.guided_target) {
                    ("GUIDED", Some(t)) => t,
                    _ => {
                        let c = s.orbit.unwrap_or_else(|| right_center(s, radius));
                        s.orbit = Some(c);
                        c
                    }
                };
                target_hdg = Some(orbit_hdg(s, c, radius));
            }
            "RTL" => {
                target_alt = rtl_alt;
                let d = s.e.hypot(s.n);
                // Volta para casa e circula por cima (o ArduPlane não pousa sozinho no RTL).
                target_hdg = Some(if d > radius * 1.6 { bearing(s, 0.0, 0.0) } else { orbit_hdg(s, (0.0, 0.0), radius) });
            }
            "AUTO" => {
                let idx = s.cur as usize;
                match s.mission.get(idx).cloned() {
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_TAKEOFF => {
                        bank_cmd = Some(0.0);
                        takeoff_roll = true;
                        climb_cmd = Some(if s.airspeed > STALL_MS + 1.0 { 4.0 } else { 0.0 });
                        if !on_ground && s.alt >= rel_z(&it) - 2.0 {
                            s.cur += 1;
                            s.leg_start = (s.e, s.n);
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                        }
                    }
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_WAYPOINT => {
                        let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                        target_hdg = Some(bearing(s, te, tn));
                        target_alt = rel_z(&it);
                        // Como o ArduPlane: chega dentro do raio (param2, ou WP_RADIUS) ou ao cruzar a
                        // linha perpendicular à perna no ponto.
                        let accept = if it.param2 > 0.0 { it.param2 as f64 } else { wp_radius };
                        let (ls_e, ls_n) = s.leg_start;
                        let crossed = (te - s.e) * (te - ls_e) + (tn - s.n) * (tn - ls_n) < 0.0;
                        if (te - s.e).hypot(tn - s.n) < accept || crossed {
                            s.cur += 1;
                            s.leg_start = (te, tn);
                            s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                        }
                    }
                    Some(it) if it.command == MavCmd::MAV_CMD_DO_LAND_START => s.cur += 1,
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_LAND => {
                        // Planeio até o ponto de toque, toca e freia na pista.
                        let (te, tn) = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                        let d = (te - s.e).hypot(tn - s.n);
                        if on_ground {
                            bank_cmd = Some(0.0);
                            target_speed = 0.0;
                            climb_cmd = Some(0.0); // na pista: não volta para a altitude do waypoint anterior
                            if s.airspeed < 0.5 {
                                s.armed = false;
                                s.go("MANUAL");
                                s.say(MavSeverity::MAV_SEVERITY_INFO, "Pouso concluído, motores desarmados");
                            }
                        } else {
                            if d > 40.0 {
                                target_hdg = Some(bearing(s, te, tn));
                            } else {
                                bank_cmd = Some(0.0);
                            }
                            target_speed = STALL_MS + 3.0;
                            climb_cmd = Some(if s.alt < 1.5 { -0.6 } else { (-(s.alt / (d.max(5.0) / (STALL_MS + 3.0)))).clamp(-3.0, -0.5) });
                        }
                    }
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_LOITER_TIME => {
                        let c = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                        target_alt = rel_z(&it);
                        let d = (c.0 - s.e).hypot(c.1 - s.n);
                        if s.loiter_until.is_none() && d > radius * 1.3 {
                            target_hdg = Some(bearing(s, c.0, c.1));
                        } else {
                            target_hdg = Some(orbit_hdg(s, c, radius));
                            let until = *s.loiter_until.get_or_insert(Instant::now() + Duration::from_secs_f32(it.param1.max(0.0)));
                            if Instant::now() >= until {
                                s.loiter_until = None;
                                s.cur += 1;
                                s.say(MavSeverity::MAV_SEVERITY_INFO, format!("Reached command #{idx}"));
                            }
                        }
                    }
                    // Circular sem fim sobre o ponto (fim de um voo só de ida), continuando em AUTO.
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_LOITER_UNLIM => {
                        let c = to_en(it.x as f64 / 1e7, it.y as f64 / 1e7);
                        target_alt = rel_z(&it);
                        let d = (c.0 - s.e).hypot(c.1 - s.n);
                        target_hdg = Some(if d > radius * 1.3 { bearing(s, c.0, c.1) } else { orbit_hdg(s, c, radius) });
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
                    Some(it) if it.command == MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH => s.go("RTL"),
                    _ => {
                        s.go("LOITER");
                        s.say(MavSeverity::MAV_SEVERITY_INFO, "Missão concluída, circulando");
                    }
                }
            }
            _ => bank_cmd = Some(0.0),
        }
    }

    // Velocidade: corrida de decolagem acelera; no chão sem decolar, freia.
    if !s.armed && on_ground || on_ground && !takeoff_roll {
        s.airspeed = (s.airspeed - 3.0 * dt).max(0.0);
    } else if on_ground {
        s.airspeed = (s.airspeed + 3.0 * dt).min(cruise);
    } else if s.armed {
        s.airspeed += (target_speed - s.airspeed) * (1.0 - (-dt * 0.6f64).exp());
    }

    // Inclinação e curva coordenada.
    let mut bank = match (bank_cmd, target_hdg) {
        (Some(b), _) => b,
        (None, Some(h)) => (wrap(h - s.hdg) * 1.1).clamp(-MAX_BANK_DEG, MAX_BANK_DEG),
        _ => 0.0,
    };
    if on_ground {
        bank = 0.0;
    }
    s.roll += (bank - s.roll) * (1.0 - (-dt * 2.5f64).exp());
    let v = s.airspeed.max(1.0);
    s.yaw_rate = if on_ground { 0.0 } else { (G * s.roll.to_radians().tan() / v).to_degrees() };
    s.hdg = (s.hdg + s.yaw_rate * dt).rem_euclid(360.0);

    // Vertical: sobe/desce para o alvo; sem sustentação ou desarmado, afunda.
    let mut vz = climb_cmd.unwrap_or(((target_alt - s.alt) * 0.35).clamp(-4.0, 4.0));
    if !on_ground && (s.airspeed < STALL_MS || !s.armed) && s.alt > 2.0 {
        vz = vz.min(-3.0);
    }
    if on_ground {
        vz = vz.max(0.0);
    }
    s.vz += (vz - s.vz) * (1.0 - (-dt * 1.5f64).exp());

    if !on_ground {
        wind.0 += (steady.0 + rand_gauss(tick) * 1.5 - wind.0) * dt * 0.5;
        wind.1 += (steady.1 + rand_gauss(tick + 7) * 1.5 - wind.1) * dt * 0.5;
    }
    let (sh, ch) = (s.hdg.to_radians().sin(), s.hdg.to_radians().cos());
    let w = if on_ground { (0.0, 0.0) } else { *wind };
    s.ve = s.airspeed * sh + w.0;
    s.vn = s.airspeed * ch + w.1;
    s.e += s.ve * dt;
    s.n += s.vn * dt;
    s.alt = (s.alt + s.vz * dt).max(0.0);
    if s.alt == 0.0 {
        s.vz = s.vz.max(0.0);
    }
    s.pitch = (s.vz / v.max(5.0)).atan().to_degrees();
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

// ---------- Motor e energia ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Propulsion {
    Electric,
    Combustion,
    Jet,
    Hybrid,
}

impl Propulsion {
    fn burns_fuel(self) -> bool {
        matches!(self, Propulsion::Combustion | Propulsion::Jet)
    }
}

/// Estados da turbina enviados em `TURB_ST` (convenção da estação, ver docs/protocolo.md).
const TURB_OFF: u8 = 0;
const TURB_READY: u8 = 1;
const TURB_IGNITION: u8 = 2;
const TURB_ACCEL: u8 = 3;
const TURB_RUNNING: u8 = 4;
const TURB_COOLING: u8 = 5;

/// Aproxima `x` de `target` com constante de tempo `tau` (s).
fn lag(x: &mut f64, target: f64, tau: f64, dt: f64) {
    *x += (target - *x) * (dt / tau).min(1.0);
}

/// Modelo térmico e de rotação do motor simulado. Só serve para a tela mostrar
/// números plausíveis: não interfere na física do voo.
struct Engine {
    kind: Propulsion,
    /// Quantos ESCs e qual deles empurra no voo horizontal (VTOL).
    escs: usize,
    pusher: Option<usize>,
    cells: usize,
    esc_rpm: Vec<f64>,
    esc_temp: Vec<f64>,
    esc_mah: Vec<f64>,
    batt_temp: f64,
    energy_wh: f64,
    /// Motor a combustível/turbina: rotação, temperaturas por cilindro e tanque.
    rpm: f64,
    cht: [f64; 2],
    egt: [f64; 2],
    flow: f64,
    tank_cm3: f64,
    fuel_used: f64,
    starved: bool,
    turb: u8,
    turb_t: f64,
    /// Gerador (híbrido).
    gen_a: f64,
    gen_rpm: f64,
    gen_temp: f64,
    rect_temp: f64,
    gen_on_s: f64,
    runtime_s: f64,
    thr: f64,
    load: f64,
}

impl Engine {
    fn new(kind: Propulsion, class: VehicleClass) -> Self {
        let (escs, pusher) = match (kind, class) {
            (Propulsion::Combustion | Propulsion::Jet, _) => (0, None),
            (_, VehicleClass::Copter) => (4, None),
            (_, VehicleClass::Vtol) => (5, Some(4)),
            _ => (1, None),
        };
        let tank_cm3 = if kind == Propulsion::Jet { 5000.0 } else { 4000.0 };
        Engine {
            kind, escs, pusher,
            cells: if kind.burns_fuel() { 3 } else { 6 },
            esc_rpm: vec![0.0; escs], esc_temp: vec![26.0; escs], esc_mah: vec![0.0; escs],
            batt_temp: 24.0, energy_wh: 0.0,
            rpm: 0.0, cht: [25.0; 2], egt: [25.0; 2], flow: 0.0,
            // Começa com o tanque a 90 %.
            tank_cm3, fuel_used: tank_cm3 * 0.1, starved: false,
            turb: TURB_READY, turb_t: 0.0,
            gen_a: 0.0, gen_rpm: 0.0, gen_temp: 25.0, rect_temp: 25.0, gen_on_s: 0.0, runtime_s: 1_262_000.0 / 3.6,
            thr: 0.0, load: 0.0,
        }
    }

    /// Tensão de cada célula: cai com a carga e a corrente; a célula 4 é a mais fraca.
    fn cells(&self, soc: f64, current: f64) -> Vec<f64> {
        const OFFSET: [f64; 6] = [0.004, -0.003, 0.002, -0.011, 0.001, -0.002];
        (0..self.cells)
            .map(|i| {
                let weak = if i == 3 { 0.0006 * current.max(0.0) } else { 0.0 };
                3.45 + 0.75 * soc - 0.002 * current + OFFSET[i] - weak
            })
            .collect()
    }

    /// Avança o modelo; devolve a corrente do gerador e um aviso, se houver.
    fn step(&mut self, dt: f64, armed: bool, load: f64, hovering: bool, current: f64, pack_v: f64) -> (f64, Option<String>) {
        let full = if hovering { 34.0 } else { 24.0 };
        self.thr = if armed { (load / full).clamp(0.0, 1.0) } else { 0.0 };
        self.load = load;
        let thr = self.thr;
        let mut note = None;
        // ESCs: a carga se divide entre os motores que estão empurrando.
        let active: Vec<usize> = (0..self.escs).filter(|&i| self.pusher.is_none() || (Some(i) == self.pusher) != hovering).collect();
        for i in 0..self.escs {
            let on = armed && active.contains(&i);
            let spread = [0.0, 140.0, -90.0, 60.0, 0.0][i % 5];
            let target = if on { 2400.0 + thr * 7800.0 + spread } else { 0.0 };
            lag(&mut self.esc_rpm[i], target, 0.15, dt);
            let share = if on { load / active.len().max(1) as f64 } else { 0.0 };
            self.esc_mah[i] += share * dt / 3.6;
            let heat = if on { 28.0 + 62.0 * thr.powf(1.5) + i as f64 * 1.5 } else { 26.0 };
            lag(&mut self.esc_temp[i], heat, 35.0, dt);
        }
        lag(&mut self.batt_temp, 24.0 + current.abs() * 0.45, 90.0, dt);
        self.energy_wh += (pack_v * current).max(0.0) * dt / 3600.0;

        match self.kind {
            Propulsion::Combustion => {
                let running = armed && !self.starved;
                lag(&mut self.rpm, if running { 1900.0 + thr * 4700.0 } else { 0.0 }, 0.5, dt);
                for i in 0..2 {
                    let hot = if running { 95.0 + 118.0 * thr + i as f64 * 7.0 } else { 25.0 };
                    lag(&mut self.cht[i], hot, if running { 50.0 } else { 140.0 }, dt);
                    lag(&mut self.egt[i], if running { 470.0 + 270.0 * thr - i as f64 * 14.0 } else { 25.0 }, 6.0, dt);
                }
                self.flow = if running { 9.0 + 70.0 * thr.powf(1.2) } else { 0.0 };
            }
            Propulsion::Jet => {
                self.turb_t += dt;
                let next = match self.turb {
                    TURB_OFF | TURB_READY if armed && !self.starved => Some(TURB_IGNITION),
                    TURB_IGNITION if self.turb_t > 3.0 => Some(TURB_ACCEL),
                    TURB_ACCEL if self.turb_t > 4.0 => Some(TURB_RUNNING),
                    TURB_IGNITION | TURB_ACCEL | TURB_RUNNING if !armed || self.starved => Some(TURB_COOLING),
                    TURB_COOLING if self.egt[0] < 120.0 => Some(TURB_READY),
                    _ => None,
                };
                if let Some(n) = next {
                    self.turb = n;
                    self.turb_t = 0.0;
                }
                let (rpm, egt, tau) = match self.turb {
                    TURB_IGNITION => (9000.0, 320.0, 1.5),
                    TURB_ACCEL => (38_000.0, 640.0, 1.2),
                    TURB_RUNNING => (38_000.0 + thr * 82_000.0, 470.0 + 210.0 * thr, 1.5),
                    // Resfriamento: o motor de partida gira devagar até a EGT baixar.
                    TURB_COOLING => (6000.0, 25.0, 12.0),
                    _ => (0.0, 25.0, 30.0),
                };
                lag(&mut self.rpm, rpm, 1.0, dt);
                lag(&mut self.egt[0], egt, tau, dt);
                self.egt[1] = self.egt[0];
                self.flow = match self.turb {
                    TURB_RUNNING => 95.0 + 380.0 * thr,
                    TURB_ACCEL => 130.0,
                    TURB_IGNITION => 40.0,
                    _ => 0.0,
                };
            }
            Propulsion::Hybrid => {
                // Gerador: aquece 8 s ao armar, depois entrega a carga e mais 4 A para carregar.
                self.gen_on_s = if armed { self.gen_on_s + dt } else { 0.0 };
                let generating = self.gen_on_s > 8.0;
                if generating {
                    self.runtime_s += dt;
                }
                lag(&mut self.gen_a, if generating { (load + 4.0).min(26.0) } else { 0.0 }, 2.0, dt);
                lag(&mut self.gen_rpm, if generating { 6200.0 + 1500.0 * self.gen_a / 26.0 } else if armed { 4500.0 } else { 0.0 }, 1.0, dt);
                lag(&mut self.gen_temp, if armed { 40.0 + 48.0 * self.gen_a / 26.0 } else { 25.0 }, 60.0, dt);
                lag(&mut self.rect_temp, if armed { 35.0 + 36.0 * self.gen_a / 26.0 } else { 25.0 }, 40.0, dt);
            }
            Propulsion::Electric => {}
        }
        if self.kind.burns_fuel() && !self.starved {
            self.fuel_used += self.flow * dt / 60.0;
            if self.fuel_used >= self.tank_cm3 {
                self.starved = true;
                note = Some("Motor parou: tanque vazio".to_string());
            }
        }
        (self.gen_a, note)
    }

    fn messages(&self, boot_ms: u32, cells: &[f64], current: f64, used: f64, soc: f64, battery: bool) -> Vec<MavMessage> {
        let mut out = vec![];
        let named = |name: &str, value: f64| MavMessage::NAMED_VALUE_FLOAT(NAMED_VALUE_FLOAT_DATA { time_boot_ms: boot_ms, value: value as f32, name: name.into() });
        // ESCs em grupos de 4, como o ArduPilot.
        for (g, chunk) in (0..self.escs).collect::<Vec<_>>().chunks(4).enumerate() {
            let mut d = ESC_TELEMETRY_1_TO_4_DATA::default();
            for (k, &i) in chunk.iter().enumerate() {
                let share = if self.esc_rpm[i] > 100.0 { current.max(0.0) / self.escs as f64 } else { 0.0 };
                d.rpm[k] = if self.esc_rpm[i] > 100.0 { (self.esc_rpm[i] + rand_gauss(boot_ms as u64 + i as u64) * 25.0).max(0.0) as u16 } else { 0 };
                d.temperature[k] = self.esc_temp[i] as u8;
                d.voltage[k] = (cells.iter().sum::<f64>() * 100.0) as u16;
                d.current[k] = (share * 100.0) as u16;
                d.totalcurrent[k] = self.esc_mah[i] as u16;
                d.count[k] = (boot_ms / 200) as u16;
            }
            out.push(match g {
                0 => MavMessage::ESC_TELEMETRY_1_TO_4(d),
                _ => MavMessage::ESC_TELEMETRY_5_TO_8(ESC_TELEMETRY_5_TO_8_DATA {
                    temperature: d.temperature, voltage: d.voltage, current: d.current, totalcurrent: d.totalcurrent, rpm: d.rpm, count: d.count,
                }),
            });
        }
        if self.kind.burns_fuel() {
            let jet = self.kind == Propulsion::Jet;
            let rpm = self.rpm + if self.rpm > 100.0 { rand_gauss(boot_ms as u64) * if jet { 180.0 } else { 20.0 } } else { 0.0 };
            out.push(MavMessage::EFI_STATUS(EFI_STATUS_DATA {
                health: 1,
                ecu_index: 0.0,
                rpm: rpm.max(0.0) as f32,
                fuel_consumed: self.fuel_used as f32,
                fuel_flow: self.flow as f32,
                engine_load: (self.thr * 100.0) as f32,
                throttle_position: (self.thr * 100.0) as f32,
                throttle_out: (self.thr * 100.0) as f32,
                cylinder_head_temperature: if jet { f32::NAN } else { self.cht[0] as f32 },
                exhaust_gas_temperature: self.egt[0] as f32,
                intake_manifold_pressure: if jet { f32::NAN } else { (38.0 + 56.0 * self.thr) as f32 },
                intake_manifold_temperature: if jet { f32::NAN } else { 31.0 },
                barometric_pressure: 92.6,
                ignition_voltage: if jet { f32::NAN } else { 12.3 },
                fuel_pressure: if jet { (40.0 + 260.0 * self.thr) as f32 } else { 290.0 },
                ..Default::default()
            }));
            out.push(MavMessage::RPM(RPM_DATA { rpm1: rpm.max(0.0) as f32, rpm2: -1.0 }));
            out.push(named("FUEL", 100.0 * (1.0 - self.fuel_used / self.tank_cm3).max(0.0)));
            if jet {
                out.push(named("TURB_ST", self.turb as f64));
                out.push(named("PUMP_V", if self.turb == TURB_RUNNING { 0.4 + 3.8 * self.thr } else if self.turb == TURB_ACCEL { 1.6 } else { 0.0 }));
            } else {
                out.push(named("CHT2", self.cht[1]));
                out.push(named("EGT2", self.egt[1]));
            }
        }
        if self.kind == Propulsion::Hybrid {
            let generating = self.gen_on_s > 8.0;
            let mut st = if generating { MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_GENERATING }
                else if self.gen_on_s > 0.0 { MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_WARMING_UP | MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_READY }
                else { MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_OFF };
            if current < -0.2 {
                st |= MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_CHARGING;
            }
            let bus: f64 = cells.iter().sum();
            out.push(MavMessage::GENERATOR_STATUS(GENERATOR_STATUS_DATA {
                status: st,
                generator_speed: self.gen_rpm as u16,
                battery_current: current as f32,
                load_current: self.load as f32,
                power_generated: (bus * self.gen_a) as f32,
                bus_voltage: bus as f32,
                rectifier_temperature: self.rect_temp as i16,
                bat_current_setpoint: 4.0,
                generator_temperature: self.gen_temp as i16,
                runtime: self.runtime_s as u32,
                time_until_maintenance: (300.0 * 3600.0 - self.runtime_s) as i32,
            }));
        }
        if battery {
            let mut voltages = [u16::MAX; 10];
            for (v, c) in voltages.iter_mut().zip(cells) {
                *v = (c * 1000.0) as u16;
            }
            let remaining_mah = (BATT_MAH - used).max(0.0);
            out.push(MavMessage::BATTERY_STATUS(BATTERY_STATUS_DATA {
                id: 0,
                battery_function: if self.kind.burns_fuel() { MavBatteryFunction::MAV_BATTERY_FUNCTION_AVIONICS } else { MavBatteryFunction::MAV_BATTERY_FUNCTION_PROPULSION },
                mavtype: MavBatteryType::MAV_BATTERY_TYPE_LIPO,
                temperature: (self.batt_temp * 100.0) as i16,
                voltages,
                current_battery: (current * 100.0) as i16,
                current_consumed: used as i32,
                energy_consumed: (self.energy_wh * 36.0) as i32,
                battery_remaining: (soc * 100.0) as i8,
                time_remaining: if current > 1.0 { (remaining_mah / current * 3.6) as i32 } else { 0 },
                charge_state: if soc < 0.15 { MavBatteryChargeState::MAV_BATTERY_CHARGE_STATE_CRITICAL } else if soc < 0.3 { MavBatteryChargeState::MAV_BATTERY_CHARGE_STATE_LOW } else { MavBatteryChargeState::MAV_BATTERY_CHARGE_STATE_OK },
                ..Default::default()
            }));
        }
        out
    }
}
