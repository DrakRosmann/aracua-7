//! Missões: montagem no formato do ArduPilot, envio (COUNT → REQUEST_INT → ITEM_INT → ACK)
//! e download do que está no veículo (REQUEST_LIST → COUNT → REQUEST_INT → ITEM_INT → ACK).

use crate::link::Link;
use crate::payload::{Action, Slot};
use aracua_bridge::apm::*;
use aracua_bridge::modes::VehicleClass;
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, serde::Deserialize, Serialize, Debug, PartialEq)]
pub struct Waypoint {
    pub lat: f64,
    pub lon: f64,
    pub alt: f32,
    /// Compartimentos de entrega a soltar neste ponto.
    #[serde(default)]
    pub drop: Vec<u32>,
}

/// Entrega num waypoint: ações para soltar e (opcional) para travar de novo.
#[derive(Clone, Debug, Default)]
pub struct DropPlan {
    pub release: Vec<Action>,
    pub relock: Vec<Action>,
    pub hold_s: f32,
}

/// Como montar a missão para este veículo.
#[derive(Clone, Copy, Debug)]
pub struct BuildOptions {
    pub class: VehicleClass,
    pub rtl_at_end: bool,
    /// Asa fixa: termina pousando (DO_LAND_START + aproximação + NAV_LAND, ou NAV_VTOL_LAND).
    pub land_at_end: bool,
    /// Rumo final do pouso em graus (de onde o avião vem para a pista). None = continua do último ponto.
    pub approach_deg: Option<f32>,
    /// Velocidade de cruzeiro do avião, para calcular onde soltar a carga em voo.
    pub cruise_ms: f32,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { class: VehicleClass::Copter, rtl_at_end: true, land_at_end: false, approach_deg: None, cruise_ms: 18.0 }
    }
}

/// Missão montada: itens e o `seq` de cada waypoint do usuário.
pub struct Built {
    pub items: Vec<MISSION_ITEM_INT_DATA>,
    pub wp_seq: Vec<u16>,
}

/// Ângulo mínimo de subida na decolagem de asa fixa (param1 do NAV_TAKEOFF; o ArduCopter ignora).
pub const PLANE_TAKEOFF_PITCH_DEG: f32 = 15.0;
/// Raio de aceitação do ponto de lançamento em voo (param2 do NAV_WAYPOINT). Também marca
/// esses pontos para que o download os reconheça.
pub const RELEASE_POINT_RADIUS_M: f32 = 2.0;
/// Fração da queda livre que a carga percorre para a frente (arrasto do ar).
const DRAG_FACTOR: f64 = 0.85;
/// Aproximação do pouso do avião: (distância do ponto de toque, altura).
const LANDING_APPROACH: [(f64, f32); 2] = [(500.0, 40.0), (250.0, 20.0)];

const EARTH_R: f64 = 6_371_000.0;

/// Rumo de a para b, em graus (0 = norte, horário).
pub fn bearing(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let dl = (b.1 - a.1).to_radians();
    let y = dl.sin() * la2.cos();
    let x = la1.cos() * la2.sin() - la1.sin() * la2.cos() * dl.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

/// Ponto a `dist` metros de `p` no rumo `brg` (plano local, bom para alguns quilômetros).
pub fn offset(p: (f64, f64), brg: f64, dist: f64) -> (f64, f64) {
    let (n, e) = (dist * brg.to_radians().cos(), dist * brg.to_radians().sin());
    (p.0 + (n / EARTH_R).to_degrees(), p.1 + (e / (EARTH_R * p.0.to_radians().cos())).to_degrees())
}

/// Quanto antes do alvo a carga deve ser solta, em metros, para cair nele.
pub fn release_lead_m(speed_ms: f64, height_m: f64) -> f64 {
    speed_ms * (2.0 * height_m.max(0.0) / 9.81).sqrt() * DRAG_FACTOR
}

fn item(seq: u16, command: MavCmd, frame: MavFrame, lat: f64, lon: f64, alt: f32, target: (u8, u8)) -> MISSION_ITEM_INT_DATA {
    MISSION_ITEM_INT_DATA {
        param1: 0.0,
        param2: 0.0,
        param3: 0.0,
        // O ArduPilot 4.7 recusa NaN aqui (MAV_MISSION_INVALID_PARAM4); 0 é o que o Mission Planner manda.
        param4: 0.0,
        x: (lat * 1e7).round() as i32,
        y: (lon * 1e7).round() as i32,
        z: alt,
        seq,
        command,
        target_system: target.0,
        target_component: target.1,
        frame,
        current: 0,
        autocontinue: 1,
        ..Default::default()
    }
}

fn do_item(seq: u16, a: &Action, target: (u8, u8)) -> MISSION_ITEM_INT_DATA {
    MISSION_ITEM_INT_DATA {
        param1: a.p1,
        param2: a.p2,
        param4: 0.0,
        ..item(seq, a.cmd, MavFrame::MAV_FRAME_MISSION, 0.0, 0.0, 0.0, target)
    }
}

/// Monta a missão no formato do ArduPilot.
///
/// Multirrotor/helicóptero: a entrega num waypoint vira DO_SET_SERVO/DO_SET_RELAY + NAV_LOITER_TIME
/// (paira enquanto a carga cai). Asa fixa: um ponto de lançamento antes do alvo, na linha de
/// chegada, a `release_lead_m` dele; a carga sai ao cruzar esse ponto e cai no alvo.
pub fn build(t: (u8, u8), home: (f64, f64, f32), wps: &[Waypoint], drops: &[DropPlan], o: BuildOptions) -> Built {
    let rel = MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT_INT;
    let fixed_wing = o.class.fixed_wing();
    let mut items = vec![item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, MavFrame::MAV_FRAME_GLOBAL_INT, home.0, home.1, home.2, t)];
    let mut wp_seq = vec![];
    let push = |items: &mut Vec<MISSION_ITEM_INT_DATA>, mut it: MISSION_ITEM_INT_DATA| {
        it.seq = items.len() as u16;
        items.push(it);
    };

    let first_alt = wps.first().map(|w| w.alt).unwrap_or(20.0);
    let mut takeoff = if o.class == VehicleClass::Vtol {
        item(0, MavCmd::MAV_CMD_NAV_VTOL_TAKEOFF, rel, 0.0, 0.0, first_alt, t)
    } else {
        item(0, MavCmd::MAV_CMD_NAV_TAKEOFF, rel, 0.0, 0.0, first_alt, t)
    };
    if o.class == VehicleClass::Plane {
        takeoff.param1 = PLANE_TAKEOFF_PITCH_DEG;
    }
    push(&mut items, takeoff);

    let mut prev = (home.0, home.1);
    for (i, w) in wps.iter().enumerate() {
        let here = (w.lat, w.lon);
        match drops.get(i).filter(|d| !d.release.is_empty()) {
            Some(d) if fixed_wing => {
                let lead = release_lead_m(o.cruise_ms as f64, w.alt as f64);
                if lead >= 3.0 {
                    let p = offset(here, bearing(prev, here) + 180.0, lead);
                    let mut rp = item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, p.0, p.1, w.alt, t);
                    rp.param2 = RELEASE_POINT_RADIUS_M;
                    push(&mut items, rp);
                }
                for a in &d.release {
                    push(&mut items, do_item(0, a, t));
                }
                wp_seq.push(items.len() as u16);
                push(&mut items, item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, w.lat, w.lon, w.alt, t));
                for a in &d.relock {
                    push(&mut items, do_item(0, a, t));
                }
            }
            Some(d) => {
                wp_seq.push(items.len() as u16);
                push(&mut items, item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, w.lat, w.lon, w.alt, t));
                for a in &d.release {
                    push(&mut items, do_item(0, a, t));
                }
                // Paira sobre o ponto enquanto a carga cai.
                let mut lt = item(0, MavCmd::MAV_CMD_NAV_LOITER_TIME, rel, w.lat, w.lon, w.alt, t);
                lt.param1 = d.hold_s.max(1.0);
                lt.param4 = 0.0;
                push(&mut items, lt);
                for a in &d.relock {
                    push(&mut items, do_item(0, a, t));
                }
            }
            None => {
                wp_seq.push(items.len() as u16);
                push(&mut items, item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, w.lat, w.lon, w.alt, t));
            }
        }
        prev = here;
    }

    let home2 = (home.0, home.1);
    if o.land_at_end && o.class == VehicleClass::Vtol {
        push(&mut items, item(0, MavCmd::MAV_CMD_NAV_VTOL_LAND, rel, home.0, home.1, 0.0, t));
    } else if o.land_at_end && o.class == VehicleClass::Plane {
        // Sequência de pouso: o RTL do ArduPlane (RTL_AUTOLAND) também pula para o DO_LAND_START.
        let course = o.approach_deg.map(|d| d as f64).unwrap_or_else(|| if prev == home2 { 0.0 } else { bearing(prev, home2) });
        let mut start = item(0, MavCmd::MAV_CMD_DO_LAND_START, rel, home.0, home.1, 0.0, t);
        start.param4 = 0.0;
        push(&mut items, start);
        for (dist, alt) in LANDING_APPROACH {
            let p = offset(home2, course + 180.0, dist);
            push(&mut items, item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, p.0, p.1, alt, t));
        }
        let mut land = item(0, MavCmd::MAV_CMD_NAV_LAND, rel, home.0, home.1, 0.0, t);
        land.param4 = 0.0;
        push(&mut items, land);
    } else if o.rtl_at_end || o.land_at_end {
        // Multirrotor/helicóptero: o RTL já pousa no home.
        push(&mut items, item(0, MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH, rel, 0.0, 0.0, 0.0, t));
    }
    Built { items, wp_seq }
}

// ---------- missão do veículo, como a interface entende ----------

/// Missão lida do veículo (ou acabada de enviar), em waypoints e entregas.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct VehicleMission {
    pub items: Vec<Waypoint>,
    pub wp_seq: Vec<u16>,
    pub rtl_at_end: bool,
    pub land_at_end: bool,
    /// Itens que a interface não sabe mostrar (DO_JUMP, condições…).
    pub ignored: u16,
    /// Total de itens no veículo, incluindo o home.
    pub count: u16,
}

/// Compartimento e "solta?" de uma ação de servo/relé, se ela for de algum compartimento.
fn slot_action(slots: &[Slot], it: &MISSION_ITEM_INT_DATA) -> Option<(u32, bool)> {
    slots.iter().find_map(|s| {
        let rel = s.actuator.action(true);
        let lock = s.actuator.action(false);
        if rel.cmd != it.command || (rel.p1 - it.param1).abs() > 0.5 {
            return None;
        }
        if (rel.p2 - it.param2).abs() <= 60.0 {
            Some((s.id, true))
        } else if (lock.p2 - it.param2).abs() <= 60.0 {
            Some((s.id, false))
        } else {
            None
        }
    })
}

/// Lê uma missão no formato do ArduPilot (como `build` monta, ou feita em outro GCS).
pub fn parse(items: &[MISSION_ITEM_INT_DATA], slots: &[Slot]) -> VehicleMission {
    let mut m = VehicleMission { count: items.len() as u16, ..Default::default() };
    let mut in_landing = false;
    // Entregas vistas num ponto de lançamento de asa fixa: passam para o próximo waypoint.
    let mut carried: Vec<u32> = vec![];
    let pos = |it: &MISSION_ITEM_INT_DATA| (it.x as f64 / 1e7, it.y as f64 / 1e7);
    for it in items.iter().skip(1) {
        use MavCmd::*;
        match it.command {
            MAV_CMD_NAV_TAKEOFF | MAV_CMD_NAV_VTOL_TAKEOFF => {}
            MAV_CMD_NAV_WAYPOINT if in_landing => {}
            MAV_CMD_NAV_WAYPOINT if it.param2 == RELEASE_POINT_RADIUS_M => {
                // Ponto de lançamento: as entregas que vêm depois pertencem ao próximo waypoint.
                m.items.push(Waypoint { lat: f64::NAN, lon: f64::NAN, alt: it.z, drop: vec![] });
            }
            MAV_CMD_NAV_WAYPOINT | MAV_CMD_NAV_LOITER_UNLIM | MAV_CMD_NAV_LOITER_TURNS | MAV_CMD_NAV_LOITER_TO_ALT
            | MAV_CMD_NAV_SPLINE_WAYPOINT => {
                // Fecha um ponto de lançamento pendente (marcado com lat NaN).
                if m.items.last().is_some_and(|w| w.lat.is_nan()) {
                    carried = m.items.pop().unwrap().drop;
                }
                let (lat, lon) = pos(it);
                m.wp_seq.push(it.seq);
                m.items.push(Waypoint { lat, lon, alt: it.z, drop: std::mem::take(&mut carried) });
            }
            MAV_CMD_NAV_LOITER_TIME => {
                // Depois de uma entrega no mesmo ponto: é a espera da entrega, não um waypoint.
                let same = m.items.last().is_some_and(|w| !w.drop.is_empty() && (w.lat - pos(it).0).abs() < 1e-6 && (w.lon - pos(it).1).abs() < 1e-6);
                if !same {
                    let (lat, lon) = pos(it);
                    m.wp_seq.push(it.seq);
                    m.items.push(Waypoint { lat, lon, alt: it.z, drop: vec![] });
                }
            }
            MAV_CMD_DO_SET_SERVO | MAV_CMD_DO_SET_RELAY => match (slot_action(slots, it), m.items.last_mut()) {
                (Some((id, true)), Some(w)) if !w.drop.contains(&id) => w.drop.push(id),
                (Some(_), _) => {}
                (None, _) => m.ignored += 1,
            },
            MAV_CMD_NAV_RETURN_TO_LAUNCH => m.rtl_at_end = true,
            MAV_CMD_DO_LAND_START => {
                in_landing = true;
                m.land_at_end = true;
            }
            MAV_CMD_NAV_LAND | MAV_CMD_NAV_VTOL_LAND => {
                in_landing = false;
                m.land_at_end = true;
            }
            _ => m.ignored += 1,
        }
    }
    // Um ponto de lançamento sem waypoint depois (missão cortada): mostra o próprio ponto.
    m.items.retain(|w| !w.lat.is_nan());
    m
}

// ---------- envio ----------

pub enum Outcome {
    InProgress,
    Done { ok: bool, result: String, count: u16, wp_seq: Vec<u16> },
}

/// Envio de itens pelo protocolo de missão. `mtype` separa missão, geocerca e pontos de pouso.
#[derive(Default)]
pub struct Uploader {
    mtype: MavMissionType,
    items: Vec<MISSION_ITEM_INT_DATA>,
    active: bool,
    last_activity: Option<Instant>,
    retries: u8,
    wp_seq: Vec<u16>,
}

impl Uploader {
    pub fn new(mtype: MavMissionType) -> Self {
        Self { mtype, ..Default::default() }
    }

    pub fn start(&mut self, link: &Link, built: Built) {
        self.items = built.items;
        self.wp_seq = built.wp_seq;
        self.active = true;
        self.retries = 0;
        self.send_count(link);
    }

    pub fn items(&self) -> &[MISSION_ITEM_INT_DATA] {
        &self.items
    }

    fn send_count(&mut self, link: &Link) {
        let (ts, tc) = link.target();
        link.send(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
            count: self.items.len() as u16,
            target_system: ts,
            target_component: tc,
            mission_type: self.mtype,
            ..Default::default()
        }));
        self.last_activity = Some(Instant::now());
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Trata mensagens do veículo relacionadas ao envio.
    pub fn handle(&mut self, link: &Link, msg: &MavMessage) -> Outcome {
        if !self.active {
            return Outcome::InProgress;
        }
        let seq = match msg {
            MavMessage::MISSION_REQUEST_INT(r) if r.mission_type == self.mtype => Some(r.seq),
            MavMessage::MISSION_REQUEST(r) if r.mission_type == self.mtype => Some(r.seq),
            MavMessage::MISSION_ACK(a) if a.mission_type == self.mtype => {
                self.active = false;
                let ok = a.mavtype == MavMissionResult::MAV_MISSION_ACCEPTED;
                return Outcome::Done { ok, result: format!("{:?}", a.mavtype), count: self.items.len() as u16, wp_seq: self.wp_seq.clone() };
            }
            _ => None,
        };
        if let Some(seq) = seq
            && let Some(it) = self.items.get(seq as usize) {
                link.send(&MavMessage::MISSION_ITEM_INT(it.clone()));
                self.last_activity = Some(Instant::now());
            }
        Outcome::InProgress
    }

    /// Reenvia a contagem se o veículo não responder; desiste após 3 tentativas.
    pub fn tick(&mut self, link: &Link) -> Outcome {
        if !self.active {
            return Outcome::InProgress;
        }
        if self.last_activity.map(|t| t.elapsed() > Duration::from_secs(3)).unwrap_or(false) {
            if self.retries >= 3 {
                self.active = false;
                return Outcome::Done { ok: false, result: "TIMEOUT".into(), count: self.items.len() as u16, wp_seq: vec![] };
            }
            self.retries += 1;
            self.send_count(link);
        }
        Outcome::InProgress
    }
}

// ---------- download ----------

pub enum Download {
    InProgress,
    Done(Result<Vec<MISSION_ITEM_INT_DATA>, String>),
}

#[derive(Default)]
pub struct Downloader {
    mtype: MavMissionType,
    active: bool,
    count: Option<u16>,
    items: Vec<MISSION_ITEM_INT_DATA>,
    last_activity: Option<Instant>,
    retries: u8,
}

impl Downloader {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn new(mtype: MavMissionType) -> Self {
        Self { mtype, ..Default::default() }
    }

    pub fn start(&mut self, link: &Link) {
        *self = Self { mtype: self.mtype, active: true, ..Default::default() };
        self.request(link);
    }

    fn request(&mut self, link: &Link) {
        let (ts, tc) = link.target();
        match self.count {
            None => link.send(&MavMessage::MISSION_REQUEST_LIST(MISSION_REQUEST_LIST_DATA {
                target_system: ts,
                target_component: tc,
                mission_type: self.mtype,
            })),
            Some(_) => link.send(&MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA {
                seq: self.items.len() as u16,
                target_system: ts,
                target_component: tc,
                mission_type: self.mtype,
            })),
        }
        self.last_activity = Some(Instant::now());
    }

    fn finish(&mut self, link: &Link) -> Download {
        self.active = false;
        let (ts, tc) = link.target();
        link.send(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
            target_system: ts,
            target_component: tc,
            mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
            mission_type: self.mtype,
            ..Default::default()
        }));
        Download::Done(Ok(std::mem::take(&mut self.items)))
    }

    pub fn handle(&mut self, link: &Link, msg: &MavMessage) -> Download {
        if !self.active {
            return Download::InProgress;
        }
        match msg {
            MavMessage::MISSION_COUNT(c) if self.count.is_none() && c.mission_type == self.mtype => {
                self.count = Some(c.count);
                self.retries = 0;
                if c.count == 0 {
                    return self.finish(link);
                }
                self.request(link);
            }
            MavMessage::MISSION_ITEM_INT(it) if self.count.is_some() && it.mission_type == self.mtype && it.seq as usize == self.items.len() => {
                self.items.push(it.clone());
                self.retries = 0;
                if self.items.len() as u16 == self.count.unwrap() {
                    return self.finish(link);
                }
                self.request(link);
            }
            _ => {}
        }
        Download::InProgress
    }

    /// Pede de novo o que não chegou; desiste após 5 tentativas.
    pub fn tick(&mut self, link: &Link) -> Download {
        if !self.active || !self.last_activity.is_some_and(|t| t.elapsed() > Duration::from_millis(1500)) {
            return Download::InProgress;
        }
        if self.retries >= 5 {
            self.active = false;
            return Download::Done(Err("o veículo não respondeu ao pedido da missão".into()));
        }
        self.retries += 1;
        self.request(link);
        Download::InProgress
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{Actuator, Store};

    fn servo(p2: f32) -> Action {
        Action { cmd: MavCmd::MAV_CMD_DO_SET_SERVO, p1: 5.0, p2 }
    }

    fn sample() -> (Vec<Waypoint>, Vec<DropPlan>) {
        let wps = vec![
            Waypoint { lat: -30.0, lon: -51.2, alt: 30.0, drop: vec![] },
            Waypoint { lat: -30.001, lon: -51.2, alt: 25.0, drop: vec![1] },
        ];
        let drops = vec![DropPlan::default(), DropPlan { release: vec![servo(1900.0)], relock: vec![servo(1100.0)], hold_s: 4.0 }];
        (wps, drops)
    }

    #[test]
    fn multirrotor_paira_para_soltar() {
        let (wps, drops) = sample();
        let b = build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, BuildOptions::default());
        let cmds: Vec<_> = b.items.iter().map(|i| i.command).collect();
        use MavCmd::*;
        assert_eq!(cmds, vec![MAV_CMD_NAV_WAYPOINT, MAV_CMD_NAV_TAKEOFF, MAV_CMD_NAV_WAYPOINT, MAV_CMD_NAV_WAYPOINT, MAV_CMD_DO_SET_SERVO, MAV_CMD_NAV_LOITER_TIME, MAV_CMD_DO_SET_SERVO, MAV_CMD_NAV_RETURN_TO_LAUNCH]);
        assert!(b.items.iter().enumerate().all(|(i, x)| x.seq as usize == i));
        assert_eq!(b.wp_seq, vec![2, 3]);
        assert_eq!(b.items[1].param1, 0.0);
        assert_eq!(b.items[5].param1, 4.0);
        assert_eq!(b.items[5].x, b.items[3].x);
    }

    #[test]
    fn aviao_solta_em_voo_e_pousa() {
        let (wps, drops) = sample();
        let o = BuildOptions { class: VehicleClass::Plane, land_at_end: true, cruise_ms: 20.0, ..Default::default() };
        let b = build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, o);
        use MavCmd::*;
        let cmds: Vec<_> = b.items.iter().map(|i| i.command).collect();
        assert_eq!(cmds, vec![
            MAV_CMD_NAV_WAYPOINT, MAV_CMD_NAV_TAKEOFF, MAV_CMD_NAV_WAYPOINT,
            MAV_CMD_NAV_WAYPOINT, MAV_CMD_DO_SET_SERVO, MAV_CMD_NAV_WAYPOINT, MAV_CMD_DO_SET_SERVO,
            MAV_CMD_DO_LAND_START, MAV_CMD_NAV_WAYPOINT, MAV_CMD_NAV_WAYPOINT, MAV_CMD_NAV_LAND,
        ]);
        assert_eq!(b.items[1].param1, PLANE_TAKEOFF_PITCH_DEG);
        // Ponto de lançamento ao norte do alvo (o avião vem do norte), à distância da queda.
        let rp = (b.items[3].x as f64 / 1e7, b.items[3].y as f64 / 1e7);
        let lead = release_lead_m(20.0, 25.0);
        assert!((lead - 38.4).abs() < 0.5, "lead = {lead}");
        let d = (rp.0 - -30.001).to_radians() * EARTH_R;
        assert!((d - lead).abs() < 0.5, "d = {d}");
        assert_eq!(b.items[3].param2, RELEASE_POINT_RADIUS_M);
        assert_eq!(b.wp_seq, vec![2, 5]);
        // Pouso no home vindo do último ponto (rumo norte), aproximação ao sul.
        let ap = &b.items[8];
        assert!((ap.x as f64 / 1e7) < -30.0);
        assert_eq!(b.items[10].x, (-30.0f64 * 1e7).round() as i32);
    }

    #[test]
    fn vtol_decola_e_pousa_na_vertical() {
        let (wps, drops) = sample();
        let o = BuildOptions { class: VehicleClass::Vtol, land_at_end: true, ..Default::default() };
        let b = build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, o);
        assert_eq!(b.items[1].command, MavCmd::MAV_CMD_NAV_VTOL_TAKEOFF);
        assert_eq!(b.items.last().unwrap().command, MavCmd::MAV_CMD_NAV_VTOL_LAND);
    }

    #[test]
    fn download_volta_ao_plano() {
        let slots = Store::default().slots;
        assert!(matches!(slots[0].actuator, Actuator::Servo { channel: 5, .. }));
        let (wps, drops) = sample();
        for class in [VehicleClass::Copter, VehicleClass::Plane, VehicleClass::Vtol] {
            let o = BuildOptions { class, land_at_end: class.fixed_wing(), ..Default::default() };
            let b = build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, o);
            let m = parse(&b.items, &slots);
            assert_eq!(m.items.len(), 2, "{class:?}");
            assert!((m.items[1].lat - -30.001).abs() < 1e-7, "{class:?}");
            assert_eq!(m.items[1].drop, vec![1], "{class:?}");
            assert!(m.items[0].drop.is_empty());
            assert_eq!(m.wp_seq, b.wp_seq, "{class:?}");
            assert_eq!(m.land_at_end, class.fixed_wing());
            assert_eq!(m.rtl_at_end, !class.fixed_wing());
            assert_eq!(m.ignored, 0);
        }
    }

    #[test]
    fn geometria() {
        let a = (-23.5, -46.6);
        let b = offset(a, 90.0, 1000.0);
        assert!((bearing(a, b) - 90.0).abs() < 0.01);
        let c = offset(a, 225.0, 300.0);
        assert!((bearing(a, c) - 225.0).abs() < 0.05);
    }
}
