//! Envio de missão pelo protocolo MAVLink (COUNT → REQUEST_INT → ITEM_INT → ACK).

use crate::link::Link;
use crate::payload::Action;
use aracua_bridge::apm::*;
use std::time::{Duration, Instant};

#[derive(Clone, serde::Deserialize, Debug)]
pub struct WaypointIn {
    pub lat: f64,
    pub lon: f64,
    pub alt: f32,
    /// Compartimentos de entrega a soltar neste ponto.
    #[serde(default)]
    pub drop: Vec<u32>,
}

pub type Waypoint = WaypointIn;

/// Entrega num waypoint: ações para soltar e (opcional) para travar de novo.
#[derive(Clone, Debug, Default)]
pub struct DropPlan {
    pub release: Vec<Action>,
    pub relock: Vec<Action>,
    pub hold_s: f32,
}

pub enum Outcome {
    InProgress,
    Done { ok: bool, result: String, count: u16, wp_seq: Vec<u16> },
}

#[derive(Default)]
pub struct Uploader {
    items: Vec<MISSION_ITEM_INT_DATA>,
    active: bool,
    last_activity: Option<Instant>,
    retries: u8,
    /// Número de sequência de cada waypoint do usuário na missão enviada.
    wp_seq: Vec<u16>,
}

fn item(seq: u16, command: MavCmd, frame: MavFrame, lat: f64, lon: f64, alt: f32, target: (u8, u8)) -> MISSION_ITEM_INT_DATA {
    MISSION_ITEM_INT_DATA {
        param1: 0.0,
        param2: 0.0,
        param3: 0.0,
        param4: f32::NAN,
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
        x: 0,
        y: 0,
        z: 0.0,
        frame: MavFrame::MAV_FRAME_MISSION,
        ..item(seq, a.cmd, MavFrame::MAV_FRAME_MISSION, 0.0, 0.0, 0.0, target)
    }
}

impl Uploader {
    /// Monta a missão no formato do ArduCopter e começa o envio.
    /// `drops[i]` é a entrega no waypoint `i`: chega ao ponto, solta (DO_SET_SERVO/DO_SET_RELAY),
    /// paira `hold_s` segundos no mesmo lugar (NAV_LOITER_TIME) e trava de novo.
    pub fn start(&mut self, link: &Link, home: (f64, f64, f32), wps: &[Waypoint], drops: &[DropPlan], rtl_at_end: bool, fixed_wing: bool) {
        self.items = build(link.target(), home, wps, drops, rtl_at_end, fixed_wing);
        self.wp_seq = self.items.iter().filter(|i| i.command == MavCmd::MAV_CMD_NAV_WAYPOINT).skip(1).map(|i| i.seq).collect();
        self.active = true;
        self.retries = 0;
        self.send_count(link);
    }
}

/// Ângulo mínimo de subida na decolagem de asa fixa (param1 do NAV_TAKEOFF; o ArduCopter ignora).
pub const PLANE_TAKEOFF_PITCH_DEG: f32 = 15.0;

pub fn build(t: (u8, u8), home: (f64, f64, f32), wps: &[Waypoint], drops: &[DropPlan], rtl_at_end: bool, fixed_wing: bool) -> Vec<MISSION_ITEM_INT_DATA> {
    {
        let rel = MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT_INT;
        let mut items = vec![item(0, MavCmd::MAV_CMD_NAV_WAYPOINT, MavFrame::MAV_FRAME_GLOBAL_INT, home.0, home.1, home.2, t)];
        let first_alt = wps.first().map(|w| w.alt).unwrap_or(20.0);
        let mut takeoff = item(1, MavCmd::MAV_CMD_NAV_TAKEOFF, rel, 0.0, 0.0, first_alt, t);
        if fixed_wing {
            takeoff.param1 = PLANE_TAKEOFF_PITCH_DEG;
        }
        items.push(takeoff);
        for (i, w) in wps.iter().enumerate() {
            let seq = items.len() as u16;
            items.push(item(seq, MavCmd::MAV_CMD_NAV_WAYPOINT, rel, w.lat, w.lon, w.alt, t));
            if let Some(d) = drops.get(i).filter(|d| !d.release.is_empty()) {
                for a in &d.release {
                    let seq = items.len() as u16;
                    items.push(do_item(seq, a, t));
                }
                // Paira sobre o ponto enquanto a carga cai.
                let seq = items.len() as u16;
                let mut lt = item(seq, MavCmd::MAV_CMD_NAV_LOITER_TIME, rel, w.lat, w.lon, w.alt, t);
                lt.param1 = d.hold_s.max(1.0);
                lt.param4 = 0.0;
                items.push(lt);
                for a in &d.relock {
                    let seq = items.len() as u16;
                    items.push(do_item(seq, a, t));
                }
            }
        }
        if rtl_at_end {
            let seq = items.len() as u16;
            items.push(item(seq, MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH, rel, 0.0, 0.0, 0.0, t));
        }
        items
    }
}

impl Uploader {

    fn send_count(&mut self, link: &Link) {
        let (ts, tc) = link.target();
        link.send(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
            count: self.items.len() as u16,
            target_system: ts,
            target_component: tc,
            ..Default::default()
        }));
        self.last_activity = Some(Instant::now());
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Trata mensagens do veículo relacionadas à missão.
    pub fn handle(&mut self, link: &Link, msg: &MavMessage) -> Outcome {
        if !self.active {
            return Outcome::InProgress;
        }
        let seq = match msg {
            MavMessage::MISSION_REQUEST_INT(r) => Some(r.seq),
            MavMessage::MISSION_REQUEST(r) => Some(r.seq),
            MavMessage::MISSION_ACK(a) => {
                self.active = false;
                let ok = a.mavtype == MavMissionResult::MAV_MISSION_ACCEPTED;
                return Outcome::Done { ok, result: format!("{:?}", a.mavtype), count: self.items.len() as u16, wp_seq: self.wp_seq.clone() };
            }
            _ => None,
        };
        if let Some(seq) = seq {
            if let Some(it) = self.items.get(seq as usize) {
                link.send(&MavMessage::MISSION_ITEM_INT(it.clone()));
                self.last_activity = Some(Instant::now());
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_items_follow_waypoint() {
        let wps = vec![
            WaypointIn { lat: -30.0, lon: -51.2, alt: 30.0, drop: vec![] },
            WaypointIn { lat: -30.001, lon: -51.2, alt: 25.0, drop: vec![1] },
        ];
        let rel = Action { cmd: MavCmd::MAV_CMD_DO_SET_SERVO, p1: 5.0, p2: 1900.0 };
        let lock = Action { cmd: MavCmd::MAV_CMD_DO_SET_SERVO, p1: 5.0, p2: 1100.0 };
        let drops = vec![DropPlan::default(), DropPlan { release: vec![rel], relock: vec![lock], hold_s: 4.0 }];
        let it = build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, true, false);
        assert_eq!(it[1].param1, 0.0);
        assert_eq!(build((1, 1), (-30.0, -51.2, 10.0), &wps, &drops, true, true)[1].param1, PLANE_TAKEOFF_PITCH_DEG);
        let cmds: Vec<_> = it.iter().map(|i| i.command).collect();
        assert_eq!(
            cmds,
            vec![
                MavCmd::MAV_CMD_NAV_WAYPOINT,
                MavCmd::MAV_CMD_NAV_TAKEOFF,
                MavCmd::MAV_CMD_NAV_WAYPOINT,
                MavCmd::MAV_CMD_NAV_WAYPOINT,
                MavCmd::MAV_CMD_DO_SET_SERVO,
                MavCmd::MAV_CMD_NAV_LOITER_TIME,
                MavCmd::MAV_CMD_DO_SET_SERVO,
                MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH,
            ]
        );
        assert!(it.iter().enumerate().all(|(i, x)| x.seq as usize == i));
        assert_eq!((it[4].param1, it[4].param2), (5.0, 1900.0));
        assert_eq!(it[5].param1, 4.0);
        assert_eq!(it[5].x, it[3].x);
    }
}
