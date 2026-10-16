//! Comandos vindos da interface e sua tradução para MAVLink.

use crate::link::Link;
use crate::mission::{DropPlan, Waypoint};
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
    Takeoff { alt: f32 },
    MissionUpload { items: Vec<Waypoint>, #[serde(default = "yes")] rtl_at_end: bool },
    MissionStart,
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
}

fn yes() -> bool {
    true
}

pub fn set_mode(link: &Link, name: &str) -> Result<(), String> {
    let n = modes::mode_number(name).ok_or_else(|| format!("modo desconhecido: {name}"))?;
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

/// Executa um comando. Erros voltam para a interface como `{type:"error"}`.
pub async fn execute(shared: &Arc<Shared>, cmd: Command) -> Result<(), String> {
    let link = &shared.link;
    match cmd {
        Command::Arm { arm, force } => {
            let magic = if force { 21196.0 } else { 0.0 };
            link.command_long(MavCmd::MAV_CMD_COMPONENT_ARM_DISARM, [arm as u8 as f32, magic, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Command::Mode { mode } => set_mode(link, &mode)?,
        Command::Takeoff { alt } => {
            if !(1.0..=500.0).contains(&alt) {
                return Err("altitude de decolagem fora de 1–500 m".into());
            }
            set_mode(link, "GUIDED")?;
            let armed = shared.state.lock().unwrap().t.armed;
            if !armed {
                tokio::time::sleep(Duration::from_millis(300)).await;
                link.command_long(MavCmd::MAV_CMD_COMPONENT_ARM_DISARM, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            link.command_long(MavCmd::MAV_CMD_NAV_TAKEOFF, [0.0, 0.0, 0.0, f32::NAN, 0.0, 0.0, alt]);
        }
        Command::MissionUpload { items, rtl_at_end } => {
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
            shared.mission.lock().unwrap().start(link, home, &items, &drops, rtl_at_end);
        }
        Command::MissionStart => {
            set_mode(link, "AUTO")?;
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
        Command::ParamSet { id, value } => {
            if !value.is_finite() {
                return Err("valor de parâmetro inválido".into());
            }
            let (ts, tc) = link.target();
            link.send(&MavMessage::PARAM_SET(PARAM_SET_DATA {
                param_value: value,
                target_system: ts,
                target_component: tc,
                param_id: param_id(&id)?,
                param_type: MavParamType::MAV_PARAM_TYPE_REAL32,
            }));
        }
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
        assert!(matches!(c, Command::MissionUpload { rtl_at_end: true, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"manual","x":0.1,"y":0,"z":0.5,"r":0}"#).unwrap();
        assert!(matches!(c, Command::Manual { .. }));
        assert!(serde_json::from_str::<Command>(r#"{"cmd":"explodir"}"#).is_err());
        let c: Command = serde_json::from_str(r#"{"cmd":"payload_release","slots":[1,3]}"#).unwrap();
        assert!(matches!(c, Command::PayloadRelease { ref slots } if slots == &vec![1, 3]));
        let c: Command = serde_json::from_str(r#"{"cmd":"payload_config","slots":[{"id":1,"name":"A","actuator":{"type":"servo","channel":5,"pwm_locked":1100,"pwm_released":1900}}],"settings":{"countdown_s":3,"min_alt_m":5,"require_armed":true,"relock_s":3,"salvo_interval_s":0.8,"mission_hold_s":4}}"#).unwrap();
        assert!(matches!(c, Command::PayloadConfig { .. }));
    }
    #[test]
    fn param_id_limits() {
        assert!(param_id("FENCE_RADIUS").is_ok());
        assert!(param_id("").is_err());
        assert!(param_id("UM_NOME_MUITO_GRANDE_DEMAIS").is_err());
    }
}
