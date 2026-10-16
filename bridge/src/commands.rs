//! Comandos vindos da interface e sua tradução para MAVLink.

use crate::link::Link;
use crate::mission::{BuildOptions, DropPlan, Waypoint};
use crate::payload::{Settings, Slot};
use crate::Shared;
use aracua_bridge::{apm::*, modes, now_ms};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize, Debug)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Arm { arm: bool, #[serde(default)] force: bool },
    Mode { mode: String },
    /// `force` pula as verificações de pré-voo da ponte (GPS, bateria).
    Takeoff { alt: f32, #[serde(default)] force: bool },
    MissionUpload {
        items: Vec<Waypoint>,
        #[serde(default = "yes")]
        rtl_at_end: bool,
        /// Asa fixa: termina com a sequência de pouso em vez de só voltar.
        #[serde(default)]
        land_at_end: bool,
        /// Rumo final do pouso (graus); sem ele, o avião continua do último ponto.
        #[serde(default)]
        approach_deg: Option<f32>,
        /// Velocidade de cruzeiro do avião (m/s), para soltar a carga em voo.
        #[serde(default)]
        cruise_ms: Option<f32>,
    },
    /// Lê a missão que está no veículo.
    MissionDownload,
    MissionStart { #[serde(default)] force: bool },
    Manual { x: f32, y: f32, z: f32, r: f32 },
    ParamGet { id: String },
    ParamSet { id: String, value: f32 },
    Photo,
    Gimbal { pitch: f32, #[serde(default)] yaw: f32 },
    MapReset,
    // ---- Sistema de entrega ----
    /// Arma ou desarma o sistema de entrega (chave geral).
    PayloadArm { arm: bool },
    /// Solta um ou mais compartimentos, com contagem regressiva.
    PayloadRelease { slots: Vec<u32> },
    /// Cancela a contagem em andamento.
    PayloadAbort,
    /// Leva o atuador para a posição travada (para recarregar).
    PayloadLock { slot: u32 },
    /// Teste de bancada: solta e trava de novo, só com os motores desarmados. Não conta.
    PayloadTest { slot: u32 },
    /// Marca o compartimento como carregado ou vazio (quando não há chave de confirmação).
    PayloadLoaded { slot: u32, loaded: bool },
    /// Substitui a lista de compartimentos e os ajustes.
    PayloadConfig { slots: Vec<Slot>, settings: Settings },
    /// Zera o contador e o histórico.
    PayloadResetCounter,
    /// Pede o estado atual.
    PayloadGet,
    // ---- Reprodução de voo gravado ----
    Replay {
        #[serde(default)]
        speed: Option<f32>,
        #[serde(default)]
        paused: Option<bool>,
        /// Segundos desde o começo da gravação.
        #[serde(default)]
        seek: Option<f64>,
    },
    // ---- Calibração ----
    /// `accel` (6 posições), `level` (nivelar), `gyro`, `compass`, `compass_accept`, `compass_cancel`.
    Calibrate { kind: String },
    /// Veículo na posição pedida pela calibração do acelerômetro.
    AccelPos { position: u32 },
    /// Reinicia a controladora (só desarmada).
    Reboot,
}

/// Comandos que fazem sentido reproduzindo um voo gravado (os outros iriam para lugar nenhum).
fn allowed_in_replay(c: &Command) -> bool {
    matches!(c, Command::Replay { .. } | Command::MapReset | Command::PayloadGet)
}

/// Limites das verificações de pré-voo da ponte.
pub const MIN_BATTERY_PCT: i8 = 25;
pub const MIN_SATS: u8 = 6;

/// Verificações de pré-voo antes de decolar ou iniciar missão. Complementam as do ArduPilot:
/// barram na estação o que costuma dar errado em campo, com a mensagem em português.
pub fn preflight(t: &crate::state::Telemetry, what: &str) -> Result<(), String> {
    let fail = |m: String| Err(format!("pré-voo ({what}): {m}"));
    if !t.connected {
        return fail("sem conexão com o veículo".into());
    }
    if t.gps.fix_type < 3 {
        return fail(format!("GPS sem fix 3D ({})", if t.gps.fix.is_empty() { "sem GPS" } else { &t.gps.fix }));
    }
    if t.gps.sats < MIN_SATS {
        return fail(format!("só {} satélites (mínimo {MIN_SATS})", t.gps.sats));
    }
    if t.battery.remaining >= 0 && t.battery.remaining < MIN_BATTERY_PCT {
        return fail(format!("bateria em {}% (mínimo {MIN_BATTERY_PCT}%)", t.battery.remaining));
    }
    if t.home.is_none() {
        return fail("o veículo ainda não definiu o home".into());
    }
    Ok(())
}

fn yes() -> bool {
    true
}

pub fn set_mode(shared: &Shared, name: &str) -> Result<(), String> {
    let class = shared.state.lock().unwrap().class;
    let n = modes::mode_number(class, name).ok_or_else(|| format!("modo {name} não existe para {}", class.as_str()))?;
    let link = &shared.link;
    // param1 = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, param2 = modo customizado.
    link.command_long(MavCmd::MAV_CMD_DO_SET_MODE, [1.0, n as f32, 0.0, 0.0, 0.0, 0.0, 0.0]);
    Ok(())
}

fn param_id(id: &str) -> Result<mavlink::types::CharArray<16>, String> {
    if id.is_empty() || id.len() > 16 || !id.is_ascii() {
        return Err(format!("id de parâmetro inválido: {id}"));
    }
    Ok(id.into())
}

fn send_param(link: &Link, id: &str, value: f32) -> Result<(), String> {
    if !value.is_finite() {
        return Err("valor de parâmetro inválido".into());
    }
    let (ts, tc) = link.target();
    link.send(&MavMessage::PARAM_SET(PARAM_SET_DATA {
        param_value: value,
        target_system: ts,
        target_component: tc,
        param_id: param_id(id)?,
        param_type: MavParamType::MAV_PARAM_TYPE_REAL32,
    }));
    Ok(())
}

/// Executa um comando. Erros voltam para a interface como `{type:"error"}`.
pub async fn execute(shared: &Arc<Shared>, cmd: Command) -> Result<(), String> {
    let link = &shared.link;
    if link.is_replay() && !allowed_in_replay(&cmd) {
        return Err("reproduzindo um voo gravado: comandos ao veículo estão desligados".into());
    }
    match cmd {
        Command::Arm { arm, force } => {
            if arm && !force {
                let t = shared.state.lock().unwrap().t.clone();
                if !t.connected {
                    return Err("sem conexão com o veículo".into());
                }
                if t.battery.remaining >= 0 && t.battery.remaining < MIN_BATTERY_PCT {
                    return Err(format!("pré-voo (armar): bateria em {}% (mínimo {MIN_BATTERY_PCT}%)", t.battery.remaining));
                }
            }
            let magic = if force { 21196.0 } else { 0.0 };
            link.command_long(MavCmd::MAV_CMD_COMPONENT_ARM_DISARM, [arm as u8 as f32, magic, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Command::Mode { mode } => set_mode(shared, &mode)?,
        Command::Takeoff { alt, force } => {
            if !(1.0..=500.0).contains(&alt) {
                return Err("altitude de decolagem fora de 1–500 m".into());
            }
            let (class, t) = {
                let s = shared.state.lock().unwrap();
                (s.class, s.t.clone())
            };
            if t.armed && t.alt_rel > 1.0 {
                return Err("o veículo já está no ar".into());
            }
            if !force {
                preflight(&t, "decolar")?;
            }
            if class == modes::VehicleClass::Rover {
                return Err("veículo terrestre: não há decolagem".into());
            }
            if class.fixed_wing() {
                // ArduPlane: altitude no TKOFF_ALT e modo TAKEOFF; arma e ele sobe em linha reta.
                send_param(link, "TKOFF_ALT", alt)?;
                set_mode(shared, "TAKEOFF")?;
                if !shared.state.lock().unwrap().t.armed {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    link.command_long(MavCmd::MAV_CMD_COMPONENT_ARM_DISARM, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                }
                return Ok(());
            }
            set_mode(shared, "GUIDED")?;
            let armed = shared.state.lock().unwrap().t.armed;
            if !armed {
                tokio::time::sleep(Duration::from_millis(300)).await;
                link.command_long(MavCmd::MAV_CMD_COMPONENT_ARM_DISARM, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            link.command_long(MavCmd::MAV_CMD_NAV_TAKEOFF, [0.0, 0.0, 0.0, f32::NAN, 0.0, 0.0, alt]);
        }
        Command::MissionUpload { items, rtl_at_end, land_at_end, approach_deg, cruise_ms } => {
            if items.is_empty() {
                return Err("missão vazia".into());
            }
            if items.len() > 700 {
                return Err("missão com mais de 700 itens".into());
            }
            let home = {
                let s = shared.state.lock().unwrap();
                match &s.t.home {
                    Some(h) => (h.lat, h.lon, h.alt),
                    None => (s.t.lat, s.t.lon, s.t.alt_msl),
                }
            };
            // Entregas nos waypoints viram itens DO_SET_SERVO/DO_SET_RELAY + LOITER_TIME.
            let drops = {
                let p = shared.payload.lock().unwrap();
                let mut drops = Vec::with_capacity(items.len());
                for w in &items {
                    let mut d = DropPlan { hold_s: p.store.settings.mission_hold_s, ..Default::default() };
                    for id in &w.drop {
                        let s = p.slot(*id).ok_or_else(|| format!("entrega na missão: compartimento {id} não existe"))?;
                        if !s.enabled {
                            return Err(format!("entrega na missão: {} está desativado", s.name));
                        }
                        d.release.push(s.actuator.action(true));
                        if p.relock_after(*id).is_some() {
                            d.relock.push(s.actuator.action(false));
                        }
                    }
                    drops.push(d);
                }
                let used: Vec<u32> = items.iter().flat_map(|w| w.drop.iter().copied()).collect();
                if used.iter().enumerate().any(|(i, id)| used[..i].contains(id)) {
                    return Err("entrega na missão: o mesmo compartimento aparece em dois pontos".into());
                }
                drops
            };
            if shared.downloader.lock().unwrap().is_active() {
                return Err("aguarde o download da missão terminar".into());
            }
            let class = shared.state.lock().unwrap().class;
            let opts = BuildOptions {
                class,
                rtl_at_end,
                land_at_end,
                approach_deg,
                cruise_ms: cruise_ms.filter(|v| (5.0..=80.0).contains(v)).unwrap_or(18.0),
            };
            // ArduPlane 4.6+ não arma com DO_LAND_START na missão e RTL_AUTOLAND desligado.
            if land_at_end && class == modes::VehicleClass::Plane {
                let cur = shared.state.lock().unwrap().params.get("RTL_AUTOLAND").copied();
                if !cur.is_some_and(|v| v >= 1.0) {
                    send_param(link, "RTL_AUTOLAND", 1.0)?;
                    shared.emit(serde_json::json!({"type":"statustext","severity":5,
                        "text":"Ponte: RTL_AUTOLAND = 1 (a missão termina com pouso; um RTL também pousa pela sequência)"}));
                }
            }
            let built = crate::mission::build(link.target(), home, &items, &drops, opts);
            shared.mission.lock().unwrap().start(link, built);
        }
        Command::MissionDownload => {
            if shared.mission.lock().unwrap().is_active() {
                return Err("aguarde o envio da missão terminar".into());
            }
            shared.downloader.lock().unwrap().start(link);
        }
        Command::MissionStart { force } => {
            let t = shared.state.lock().unwrap().t.clone();
            let on_vehicle = shared.vehicle_mission.lock().unwrap().as_ref().map(|m| m.items.len());
            if on_vehicle == Some(0) {
                return Err("não há missão no veículo: envie uma antes".into());
            }
            // Já no ar, iniciar a missão é só mudar de modo; no chão, vale o pré-voo.
            if !force && !(t.armed && t.alt_rel > 1.0) {
                preflight(&t, "iniciar missão")?;
            }
            set_mode(shared, "AUTO")?;
            link.command_long(MavCmd::MAV_CMD_MISSION_START, [0.0; 7]);
        }
        Command::Manual { x, y, z, r } => {
            let (ts, _) = link.target();
            let s = |v: f32| (v.clamp(-1.0, 1.0) * 1000.0) as i16;
            link.send(&MavMessage::MANUAL_CONTROL(MANUAL_CONTROL_DATA {
                x: s(x),
                y: s(y),
                z: (z.clamp(0.0, 1.0) * 1000.0) as i16,
                r: s(r),
                buttons: 0,
                target: ts,
                ..Default::default()
            }));
        }
        Command::ParamGet { id } => {
            let (ts, tc) = link.target();
            link.send(&MavMessage::PARAM_REQUEST_READ(PARAM_REQUEST_READ_DATA {
                param_index: -1,
                target_system: ts,
                target_component: tc,
                param_id: param_id(&id)?,
            }));
        }
        Command::ParamSet { id, value } => send_param(link, &id, value)?,
        Command::Photo => link.command_long(MavCmd::MAV_CMD_DO_DIGICAM_CONTROL, [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
        Command::Gimbal { pitch, yaw } => {
            // param7 = MAV_MOUNT_MODE_MAVLINK_TARGETING
            link.command_long(MavCmd::MAV_CMD_DO_MOUNT_CONTROL, [pitch.clamp(-90.0, 30.0), 0.0, yaw, 0.0, 0.0, 0.0, 2.0]);
        }
        Command::MapReset => shared.reset_map(),
        Command::PayloadArm { arm } => {
            {
                let mut p = shared.payload.lock().unwrap();
                if arm {
                    if !shared.state.lock().unwrap().t.connected {
                        return Err("sem conexão com o veículo".into());
                    }
                    p.armed = true;
                    p.last_message = None;
                } else {
                    p.armed = false;
                    p.abort("sistema desarmado");
                }
            }
            tracing::info!("entrega {}", if arm { "armada" } else { "desarmada" });
            shared.emit_payload();
        }
        Command::PayloadRelease { slots } => {
            let v = shared.vehicle_now();
            let epoch = {
                let mut p = shared.payload.lock().unwrap();
                if p.countdown.is_some() {
                    return Err("já existe uma contagem em andamento".into());
                }
                if let Err(e) = p.check_release(&slots, &v) {
                    p.last_message = Some(e.clone());
                    drop(p);
                    shared.emit_payload();
                    return Err(e);
                }
                if p.store.settings.countdown_s == 0 {
                    None
                } else {
                    Some(p.start_countdown(slots.clone(), now_ms()).epoch)
                }
            };
            shared.emit_payload();
            release_sequence(shared.clone(), slots, epoch).await;
        }
        Command::PayloadAbort => {
            if shared.payload.lock().unwrap().abort("cancelada pelo operador") {
                tracing::warn!("entrega: contagem abortada pelo operador");
            }
            shared.emit_payload();
        }
        Command::PayloadLock { slot } => {
            let a = {
                let mut p = shared.payload.lock().unwrap();
                p.note_commanded(slot, now_ms());
                p.slot(slot).ok_or("compartimento não existe")?.actuator.action(false)
            };
            link.command_long(a.cmd, [a.p1, a.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Command::PayloadTest { slot } => {
            if shared.state.lock().unwrap().t.armed {
                return Err("teste só com os motores desarmados".into());
            }
            let (rel, lock, pulse) = {
                let mut p = shared.payload.lock().unwrap();
                if p.countdown.is_some() {
                    return Err("há uma contagem em andamento".into());
                }
                p.note_commanded(slot, now_ms());
                let s = p.slot(slot).ok_or("compartimento não existe")?;
                (s.actuator.action(true), s.actuator.action(false), p.relock_after(slot).unwrap_or(1.0).min(2.0))
            };
            link.command_long(rel.cmd, [rel.p1, rel.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
            tokio::time::sleep(Duration::from_secs_f32(pulse)).await;
            shared.payload.lock().unwrap().note_commanded(slot, now_ms());
            link.command_long(lock.cmd, [lock.p1, lock.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Command::PayloadLoaded { slot, loaded } => {
            shared.payload.lock().unwrap().mark_loaded(slot, loaded)?;
            shared.emit_payload();
        }
        Command::PayloadConfig { slots, settings } => {
            shared.payload.lock().unwrap().set_config(slots, settings)?;
            shared.emit_payload();
        }
        Command::PayloadResetCounter => {
            {
                let p = shared.payload.lock().unwrap();
                if p.countdown.is_some() {
                    return Err("há uma contagem em andamento".into());
                }
            }
            shared.payload.lock().unwrap().reset_counter();
            shared.emit_payload();
        }
        Command::PayloadGet => shared.emit_payload(),
        Command::Replay { speed, paused, seek } => {
            let ctl = link.replay.as_ref().ok_or("não há voo gravado em reprodução")?;
            if let Some(s) = speed {
                ctl.set_speed(s);
            }
            if let Some(t) = seek {
                ctl.seek(t);
            }
            if let Some(p) = paused {
                ctl.set_paused(p);
            }
            shared.emit_replay();
        }
        Command::Calibrate { kind } => {
            let armed = shared.state.lock().unwrap().t.armed;
            if armed {
                return Err("calibração só com os motores desarmados".into());
            }
            use MavCmd::*;
            match kind.as_str() {
                // PREFLIGHT_CALIBRATION: param1 giroscópio, param5 = 1 acelerômetro (6 posições), 2 nivelar.
                "gyro" => link.command_long(MAV_CMD_PREFLIGHT_CALIBRATION, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
                "accel" => link.command_long(MAV_CMD_PREFLIGHT_CALIBRATION, [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
                "level" => link.command_long(MAV_CMD_PREFLIGHT_CALIBRATION, [0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0]),
                // Bússola: todas (máscara 0), repetir se falhar, salvar sozinho.
                "compass" => link.command_long(MAV_CMD_DO_START_MAG_CAL, [0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0]),
                "compass_accept" => link.command_long(MAV_CMD_DO_ACCEPT_MAG_CAL, [0.0; 7]),
                "compass_cancel" => link.command_long(MAV_CMD_DO_CANCEL_MAG_CAL, [0.0; 7]),
                _ => return Err(format!("calibração desconhecida: {kind}")),
            }
        }
        Command::AccelPos { position } => {
            if !(1..=6).contains(&position) {
                return Err("posição de calibração inválida".into());
            }
            link.command_long(MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS, [position as f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Command::Reboot => {
            if shared.state.lock().unwrap().t.armed {
                return Err("reinício só com os motores desarmados".into());
            }
            link.command_long(MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
    }
    Ok(())
}

/// Contagem regressiva (se houver) e soltura dos compartimentos, um após o outro.
/// As travas de segurança são conferidas de novo a cada 100 ms e no instante de soltar.
async fn release_sequence(shared: Arc<Shared>, ids: Vec<u32>, epoch: Option<u64>) {
    if let Some(epoch) = epoch {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let v = shared.vehicle_now();
            let mut p = shared.payload.lock().unwrap();
            if !p.countdown_valid(epoch) {
                return; // abortada
            }
            if let Err(e) = p.check_release(&ids, &v) {
                p.abort(&e);
                drop(p);
                tracing::warn!("entrega: contagem abortada: {e}");
                shared.emit_payload();
                return;
            }
            let remaining = p.countdown.as_ref().map(|c| c.ends_at_ms.saturating_sub(now_ms())).unwrap_or(0);
            if remaining == 0 {
                if !p.finish_countdown(epoch) {
                    return;
                }
                break;
            }
        }
    }
    let interval = shared.payload.lock().unwrap().store.settings.salvo_interval_s;
    for (i, id) in ids.iter().copied().enumerate() {
        if i > 0 && interval > 0.0 {
            tokio::time::sleep(Duration::from_secs_f32(interval)).await;
        }
        let v = shared.vehicle_now();
        let (action, relock, ev) = {
            let mut p = shared.payload.lock().unwrap();
            if let Err(e) = p.check_release(&[id], &v) {
                p.last_message = Some(format!("salva interrompida: {e}"));
                drop(p);
                shared.emit_payload();
                return;
            }
            let action = p.slot(id).map(|s| s.actuator.action(true));
            let relock = p.relock_after(id);
            let ev = p.record(id, &v, "estação", now_ms());
            (action, relock, ev)
        };
        let (Some(a), Some(ev)) = (action, ev) else { continue };
        shared.link.command_long(a.cmd, [a.p1, a.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
        tracing::info!("entrega: lançamento nº {} — {} a {:.1} m", ev.n, ev.name, ev.alt_rel);
        shared.emit(serde_json::json!({"type":"payload_release","event":ev}));
        shared.emit_payload();
        if let Some(secs) = relock {
            let s = shared.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs_f32(secs)).await;
                let lock = {
                    let mut p = s.payload.lock().unwrap();
                    p.note_commanded(id, now_ms());
                    p.slot(id).map(|sl| sl.actuator.action(false))
                };
                if let Some(l) = lock {
                    s.link.command_long(l.cmd, [l.p1, l.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_commands() {
        let c: Command = serde_json::from_str(r#"{"cmd":"arm","arm":true}"#).unwrap();
        assert!(matches!(c, Command::Arm { arm: true, force: false }));
        let c: Command = serde_json::from_str(r#"{"cmd":"mission_upload","items":[{"lat":-23.5,"lon":-46.6,"alt":40}]}"#).unwrap();
        assert!(matches!(c, Command::MissionUpload { rtl_at_end: true, land_at_end: false, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"mission_upload","items":[],"land_at_end":true,"approach_deg":270,"cruise_ms":20}"#).unwrap();
        assert!(matches!(c, Command::MissionUpload { land_at_end: true, approach_deg: Some(a), cruise_ms: Some(v), .. } if a == 270.0 && v == 20.0));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"mission_start"}"#).unwrap(), Command::MissionStart { force: false }));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"takeoff","alt":20}"#).unwrap(), Command::Takeoff { force: false, .. }));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"replay","speed":4}"#).unwrap(), Command::Replay { speed: Some(_), paused: None, seek: None }));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"calibrate","kind":"accel"}"#).unwrap(), Command::Calibrate { .. }));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"cmd":"accel_pos","position":3}"#).unwrap(), Command::AccelPos { position: 3 }));
        let c: Command = serde_json::from_str(r#"{"cmd":"manual","x":0.1,"y":0,"z":0.5,"r":0}"#).unwrap();
        assert!(matches!(c, Command::Manual { .. }));
        assert!(serde_json::from_str::<Command>(r#"{"cmd":"explodir"}"#).is_err());
        let c: Command = serde_json::from_str(r#"{"cmd":"payload_release","slots":[1,3]}"#).unwrap();
        assert!(matches!(c, Command::PayloadRelease { ref slots } if slots == &vec![1, 3]));
        let c: Command = serde_json::from_str(r#"{"cmd":"payload_config","slots":[{"id":1,"name":"A","actuator":{"type":"servo","channel":5,"pwm_locked":1100,"pwm_released":1900}}],"settings":{"countdown_s":3,"min_alt_m":5,"require_armed":true,"relock_s":3,"salvo_interval_s":0.8,"mission_hold_s":4}}"#).unwrap();
        assert!(matches!(c, Command::PayloadConfig { .. }));
    }
    #[test]
    fn verificacoes_de_pre_voo() {
        use crate::state::{Home, Telemetry};
        let mut t = Telemetry { connected: true, ..Default::default() };
        t.gps.fix_type = 3;
        t.gps.fix = "3D_FIX".into();
        t.gps.sats = 12;
        t.battery.remaining = 80;
        t.home = Some(Home { lat: -23.5, lon: -46.6, alt: 760.0 });
        assert!(preflight(&t, "decolar").is_ok());
        let check = |f: &dyn Fn(&mut Telemetry), msg: &str| {
            let mut x = t.clone();
            f(&mut x);
            let e = preflight(&x, "decolar").unwrap_err();
            assert!(e.contains(msg), "{e}");
        };
        check(&|x| x.connected = false, "sem conexão");
        check(&|x| x.gps.fix_type = 2, "GPS sem fix 3D");
        check(&|x| x.gps.sats = 4, "satélites");
        check(&|x| x.battery.remaining = 20, "bateria em 20%");
        check(&|x| x.home = None, "home");
        // Bateria desconhecida (-1) não bloqueia.
        let mut x = t.clone();
        x.battery.remaining = -1;
        assert!(preflight(&x, "decolar").is_ok());
    }

    #[test]
    fn reproducao_so_aceita_controle() {
        assert!(allowed_in_replay(&Command::Replay { speed: None, paused: Some(true), seek: None }));
        assert!(!allowed_in_replay(&Command::Arm { arm: true, force: false }));
        assert!(!allowed_in_replay(&Command::Takeoff { alt: 10.0, force: true }));
    }

    #[test]
    fn param_id_limits() {
        assert!(param_id("FENCE_RADIUS").is_ok());
        assert!(param_id("").is_err());
        assert!(param_id("UM_NOME_MUITO_GRANDE_DEMAIS").is_err());
    }
}
