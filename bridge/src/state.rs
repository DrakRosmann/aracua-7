//! Estado do veículo montado a partir das mensagens MAVLink.

use crate::propulsion::Propulsion;
use aracua_bridge::{apm::*, char_array_to_string, modes, now_ms};
use mavlink::Message;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Default)]
pub struct Battery {
    pub voltage: f32,
    pub current: f32,
    pub remaining: i8,
    pub consumed_mah: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct Gps {
    pub fix_type: u8,
    pub fix: String,
    pub sats: u8,
    pub hdop: f32,
}

#[derive(Serialize, Clone, Default)]
pub struct Home {
    pub lat: f64,
    pub lon: f64,
    pub alt: f32,
}

#[derive(Serialize, Clone, Default)]
pub struct Radio {
    pub rssi: u8,
    pub remrssi: u8,
    pub noise: u8,
    pub remnoise: u8,
    pub rxerrors: u16,
    pub fixed: u16,
}

/// Vento estimado pelo piloto automático (WIND do ArduPilot).
#[derive(Serialize, Clone, Default)]
pub struct Wind {
    /// De onde o vento vem, em graus verdadeiros.
    pub dir: f32,
    pub speed: f32,
    pub speed_z: f32,
}

#[derive(Serialize, Clone, Default)]
pub struct MsgStat {
    pub count: u64,
    pub hz: f32,
}

#[derive(Serialize, Clone, Default)]
pub struct Telemetry {
    pub connected: bool,
    pub heartbeat_age_ms: u64,
    pub system_id: u8,
    pub autopilot: String,
    pub vehicle_type: String,
    /// copter, heli, plane, vtol ou rover: decide a tabela de modos e os comandos.
    pub vehicle_class: String,
    pub armed: bool,
    pub mode: String,
    pub custom_mode: u32,
    pub system_status: String,
    pub lat: f64,
    pub lon: f64,
    pub alt_msl: f32,
    pub alt_rel: f32,
    pub heading: f32,
    pub roll: f32,
    pub pitch: f32,
    pub yaw: f32,
    pub roll_rate: f32,
    pub pitch_rate: f32,
    pub yaw_rate: f32,
    pub vn: f32,
    pub ve: f32,
    pub vd: f32,
    pub groundspeed: f32,
    pub airspeed: f32,
    pub climb: f32,
    pub throttle: u16,
    pub battery: Battery,
    pub gps: Gps,
    pub home: Option<Home>,
    pub rangefinder: Option<f32>,
    pub vibration: [f32; 3],
    pub clipping: [u32; 3],
    pub radio: Option<Radio>,
    pub drop_rate_comm: f32,
    pub sensors_healthy: bool,
    pub mission_current: u16,
    pub mission_count: u16,
    /// Canais do rádio (PWM), para a calibração do rádio na interface.
    pub rc: Vec<u16>,
    pub rc_rssi: u8,
    pub msgs_per_sec: f32,
    pub msg_stats: BTreeMap<String, MsgStat>,
    /// Motor e energia: baterias, ESCs, EFI, gerador e sensores extras.
    pub propulsion: Propulsion,
    /// Vento estimado; None até o veículo mandar (o ArduCopter só manda com a estimativa ligada).
    pub wind: Option<Wind>,
}

/// Eventos pontuais que viram mensagens próprias para a interface.
pub enum Event {
    StatusText { severity: u8, text: String },
    Ack { command: String, result: String },
    Param { id: String, value: f32, index: u16, count: u16 },
    /// Andamento das calibrações (acelerômetro, bússola).
    Calib(serde_json::Value),
}

#[derive(Default)]
pub struct State {
    pub t: Telemetry,
    pub class: modes::VehicleClass,
    /// Parâmetros já lidos do veículo.
    pub params: BTreeMap<String, f32>,
    last_heartbeat_ms: u64,
    counts: BTreeMap<&'static str, u64>,
    counts_prev: BTreeMap<&'static str, u64>,
    total: u64,
    total_prev: u64,
    rates_at_ms: u64,
}

fn deg(r: f32) -> f32 {
    r.to_degrees()
}

impl State {
    /// Atualiza o estado; retorna um evento se a mensagem gerar um.
    pub fn update(&mut self, sys: u8, comp: u8, msg: &MavMessage) -> Option<Event> {
        *self.counts.entry(msg.message_name()).or_insert(0) += 1;
        self.total += 1;
        // Mensagens de motor/energia; BATTERY_STATUS e NAMED_VALUE_FLOAT seguem adiante.
        self.t.propulsion.update(msg, now_ms());
        use MavMessage::*;
        match msg {
            HEARTBEAT(h) => {
                // Só o piloto automático define o estado do veículo.
                if comp != 1 || h.autopilot == MavAutopilot::MAV_AUTOPILOT_INVALID {
                    return None;
                }
                // Outro veículo (ou outro tipo) na mesma ponte: o motor do anterior não vale mais.
                if self.last_heartbeat_ms != 0 && (self.t.system_id != sys || self.t.vehicle_type != format!("{:?}", h.mavtype).replace("MAV_TYPE_", "")) {
                    self.t.propulsion = Default::default();
                }
                self.last_heartbeat_ms = now_ms();
                self.t.system_id = sys;
                self.t.armed = h.base_mode.contains(MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED);
                self.class = modes::VehicleClass::from_mav_type(h.mavtype);
                self.t.vehicle_class = self.class.as_str().into();
                self.t.custom_mode = h.custom_mode;
                self.t.mode = modes::mode_name(self.class, h.custom_mode);
                self.t.system_status = format!("{:?}", h.system_status).replace("MAV_STATE_", "");
                self.t.autopilot = format!("{:?}", h.autopilot).replace("MAV_AUTOPILOT_", "");
                self.t.vehicle_type = format!("{:?}", h.mavtype).replace("MAV_TYPE_", "");
            }
            ATTITUDE(a) => {
                self.t.roll = deg(a.roll);
                self.t.pitch = deg(a.pitch);
                self.t.yaw = deg(a.yaw);
                self.t.roll_rate = deg(a.rollspeed);
                self.t.pitch_rate = deg(a.pitchspeed);
                self.t.yaw_rate = deg(a.yawspeed);
            }
            GLOBAL_POSITION_INT(p) => {
                self.t.lat = p.lat as f64 / 1e7;
                self.t.lon = p.lon as f64 / 1e7;
                self.t.alt_msl = p.alt as f32 / 1000.0;
                self.t.alt_rel = p.relative_alt as f32 / 1000.0;
                self.t.vn = p.vx as f32 / 100.0;
                self.t.ve = p.vy as f32 / 100.0;
                self.t.vd = p.vz as f32 / 100.0;
                if p.hdg != u16::MAX {
                    self.t.heading = p.hdg as f32 / 100.0;
                }
            }
            VFR_HUD(v) => {
                self.t.groundspeed = v.groundspeed;
                self.t.airspeed = v.airspeed;
                self.t.climb = v.climb;
                self.t.throttle = v.throttle;
                self.t.heading = v.heading as f32;
            }
            SYS_STATUS(s) => {
                self.t.battery.voltage = s.voltage_battery as f32 / 1000.0;
                self.t.battery.current = s.current_battery.max(0) as f32 / 100.0;
                self.t.battery.remaining = s.battery_remaining;
                self.t.drop_rate_comm = s.drop_rate_comm as f32 / 100.0;
                self.t.sensors_healthy = (s.onboard_control_sensors_health
                    & s.onboard_control_sensors_enabled)
                    == s.onboard_control_sensors_enabled;
            }
            BATTERY_STATUS(b) => {
                if b.id == 0 && b.current_consumed >= 0 {
                    self.t.battery.consumed_mah = b.current_consumed;
                }
            }
            GPS_RAW_INT(g) => {
                self.t.gps.fix_type = g.fix_type as u8;
                self.t.gps.fix = format!("{:?}", g.fix_type).replace("GPS_FIX_TYPE_", "");
                self.t.gps.sats = g.satellites_visible;
                self.t.gps.hdop = if g.eph == u16::MAX { 99.0 } else { g.eph as f32 / 100.0 };
            }
            HOME_POSITION(h) => {
                self.t.home = Some(Home {
                    lat: h.latitude as f64 / 1e7,
                    lon: h.longitude as f64 / 1e7,
                    alt: h.altitude as f32 / 1000.0,
                });
            }
            WIND(w) => self.t.wind = Some(Wind { dir: w.direction.rem_euclid(360.0), speed: w.speed, speed_z: w.speed_z }),
            RANGEFINDER(r) => self.t.rangefinder = Some(r.distance),
            DISTANCE_SENSOR(d) => self.t.rangefinder = Some(d.current_distance as f32 / 100.0),
            VIBRATION(v) => {
                self.t.vibration = [v.vibration_x, v.vibration_y, v.vibration_z];
                self.t.clipping = [v.clipping_0, v.clipping_1, v.clipping_2];
            }
            RADIO_STATUS(r) => {
                self.t.radio = Some(Radio {
                    rssi: r.rssi,
                    remrssi: r.remrssi,
                    noise: r.noise,
                    remnoise: r.remnoise,
                    rxerrors: r.rxerrors,
                    fixed: r.fixed,
                })
            }
            MISSION_CURRENT(m) => {
                self.t.mission_current = m.seq;
                if m.total != u16::MAX && m.total > 0 {
                    self.t.mission_count = m.total;
                }
            }
            RC_CHANNELS(r) => {
                let all = [
                    r.chan1_raw, r.chan2_raw, r.chan3_raw, r.chan4_raw, r.chan5_raw, r.chan6_raw, r.chan7_raw, r.chan8_raw,
                    r.chan9_raw, r.chan10_raw, r.chan11_raw, r.chan12_raw, r.chan13_raw, r.chan14_raw, r.chan15_raw, r.chan16_raw,
                ];
                self.t.rc = all[..(r.chancount as usize).min(16)].to_vec();
                self.t.rc_rssi = r.rssi;
            }
            // O ArduPilot pede cada posição da calibração do acelerômetro com um COMMAND_LONG para a estação.
            COMMAND_LONG(c) if c.command == MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS => {
                let p = c.param1 as u32;
                let status = match p {
                    16_777_215 => "success",
                    16_777_216 => "failed",
                    _ => "position",
                };
                return Some(Event::Calib(serde_json::json!({"kind":"accel","status":status,"position":p})));
            }
            MAG_CAL_PROGRESS(m) => {
                return Some(Event::Calib(serde_json::json!({
                    "kind":"compass","compass":m.compass_id,"pct":m.completion_pct,"attempt":m.attempt,
                    "status":format!("{:?}", m.cal_status).replace("MAG_CAL_", "").to_lowercase(),
                })));
            }
            MAG_CAL_REPORT(m) => {
                return Some(Event::Calib(serde_json::json!({
                    "kind":"compass_report","compass":m.compass_id,"fitness":m.fitness,"autosaved":m.autosaved == 1,
                    "status":format!("{:?}", m.cal_status).replace("MAG_CAL_", "").to_lowercase(),
                })));
            }
            STATUSTEXT(s) => {
                return Some(Event::StatusText {
                    severity: s.severity as u8,
                    text: char_array_to_string(&s.text),
                })
            }
            COMMAND_ACK(a) => {
                return Some(Event::Ack {
                    command: format!("{:?}", a.command),
                    result: format!("{:?}", a.result),
                })
            }
            PARAM_VALUE(p) => {
                self.params.insert(char_array_to_string(&p.param_id), p.param_value);
                return Some(Event::Param {
                    id: char_array_to_string(&p.param_id),
                    value: p.param_value,
                    index: p.param_index,
                    count: p.param_count,
                })
            }
            _ => {}
        }
        None
    }

    /// Reprodução pausada: o veículo não "some" só porque o tempo parou.
    pub fn hold_heartbeat(&mut self) {
        if self.last_heartbeat_ms != 0 {
            self.last_heartbeat_ms = now_ms();
        }
    }

    /// Fotografia do estado para enviar à interface.
    pub fn snapshot(&mut self) -> Telemetry {
        let now = now_ms();
        let age = now.saturating_sub(self.last_heartbeat_ms);
        self.t.heartbeat_age_ms = if self.last_heartbeat_ms == 0 { u64::MAX } else { age };
        self.t.connected = self.last_heartbeat_ms != 0 && age < 3000;
        self.t.propulsion.refresh(now);
        // Taxas de mensagem recalculadas a cada segundo.
        if now.saturating_sub(self.rates_at_ms) >= 1000 {
            let dt = if self.rates_at_ms == 0 { 1.0 } else { (now - self.rates_at_ms) as f32 / 1000.0 };
            for (name, c) in &self.counts {
                let prev = self.counts_prev.get(name).copied().unwrap_or(0);
                self.t.msg_stats.insert(
                    name.to_string(),
                    MsgStat { count: *c, hz: (c - prev) as f32 / dt },
                );
            }
            self.t.msgs_per_sec = (self.total - self.total_prev) as f32 / dt;
            self.counts_prev = self.counts.clone();
            self.total_prev = self.total;
            self.rates_at_ms = now;
        }
        self.t.clone()
    }
}
