//! Sistema de entrega: compartimentos com pino de trava, contagem regressiva e contador de lançamentos.
//!
//! Cada compartimento tem um atuador (servo que puxa o pino ou solenoide num relé) e, opcionalmente,
//! uma chave de fim de curso lida pelo script `entrega.lua`, que chega aqui como
//! NAMED_VALUE_FLOAT "ENT_SW" (bit n = compartimento com pino travado).
//!
//! A configuração, o contador e o histórico ficam num arquivo JSON, para sobreviver a reinícios da ponte.

use aracua_bridge::apm::MavCmd;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// Quantos lançamentos o histórico guarda.
const LOG_MAX: usize = 1000;
/// Tempo para a chave confirmar que o pino saiu.
pub const CONFIRM_MS: u64 = 2000;
/// Depois disso sem "ENT_SW", as chaves são consideradas sem leitura.
const SWITCH_STALE_MS: u64 = 3000;
/// Tolerância ao comparar PWM lido com o configurado.
const PWM_TOL: i32 = 60;
/// Pulso mínimo de um solenoide quando "retravar" está desligado (evita deixá-lo energizado).
const SOLENOID_PULSE_S: f32 = 1.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Actuator {
    /// Servo numa saída SERVOn (com SERVOn_FUNCTION = 0).
    Servo { channel: u8, pwm_locked: u16, pwm_released: u16 },
    /// Solenoide ou trava elétrica num relé (instância 0-based do MAV_CMD_DO_SET_RELAY).
    Relay { relay: u8 },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Slot {
    pub id: u32,
    pub name: String,
    pub actuator: Actuator,
    /// Bit da chave de confirmação em ENT_SW (0–5 na placa Aracuã-7); None = sem chave.
    #[serde(default)]
    pub switch_bit: Option<u8>,
    /// Massa da carga, para o painel mostrar quanto peso ainda está a bordo.
    #[serde(default)]
    pub mass_g: f32,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub loaded: bool,
    /// Lançamentos feitos por este compartimento (contador acumulado).
    #[serde(default)]
    pub releases: u32,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// Contagem regressiva antes de soltar, em segundos (0 = imediato).
    pub countdown_s: u8,
    /// Altura mínima em relação à decolagem para soltar (0 = sem limite).
    pub min_alt_m: f32,
    /// Só solta com os motores armados.
    pub require_armed: bool,
    /// Volta o atuador para "travado" depois de N segundos (0 = fica na posição solta).
    pub relock_s: f32,
    /// Intervalo entre compartimentos numa salva (vários de uma vez).
    pub salvo_interval_s: f32,
    /// Tempo pairando sobre o ponto quando a entrega é feita numa missão.
    pub mission_hold_s: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { countdown_s: 3, min_alt_m: 5.0, require_armed: true, relock_s: 3.0, salvo_interval_s: 0.8, mission_hold_s: 4.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReleaseEvent {
    /// Número do lançamento no contador geral.
    pub n: u32,
    pub slot: u32,
    pub name: String,
    pub t: u64,
    pub lat: f64,
    pub lon: f64,
    pub alt_rel: f32,
    pub groundspeed: f32,
    pub mass_g: f32,
    /// "estação" (botão), "missão" (item de missão) ou "externo" (rádio, outro GCS).
    pub source: String,
    /// true/false pela chave de fim de curso; None quando não há chave.
    pub confirmed: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Store {
    pub slots: Vec<Slot>,
    pub settings: Settings,
    pub total: u32,
    pub log: Vec<ReleaseEvent>,
}

impl Default for Store {
    fn default() -> Self {
        // Placa Aracuã-7: ENT1–ENT4 nas saídas 5–8, chaves nos bits 0–3.
        let slots = (0..4u8)
            .map(|i| Slot {
                id: i as u32 + 1,
                name: format!("ENT{}", i + 1),
                actuator: Actuator::Servo { channel: 5 + i, pwm_locked: 1100, pwm_released: 1900 },
                switch_bit: Some(i),
                mass_g: 250.0,
                enabled: true,
                loaded: false,
                releases: 0,
            })
            .collect();
        Self { slots, settings: Settings::default(), total: 0, log: vec![] }
    }
}

/// Dados do veículo no instante do lançamento.
#[derive(Clone, Copy, Default)]
pub struct VehicleNow {
    pub connected: bool,
    pub armed: bool,
    pub lat: f64,
    pub lon: f64,
    pub alt_rel: f32,
    pub groundspeed: f32,
}

#[derive(Clone, Debug)]
pub struct Countdown {
    pub slots: Vec<u32>,
    pub ends_at_ms: u64,
    pub total_ms: u64,
    pub epoch: u64,
}

/// Comando MAVLink que move um atuador.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Action {
    pub cmd: MavCmd,
    pub p1: f32,
    pub p2: f32,
}

impl Actuator {
    pub fn action(&self, release: bool) -> Action {
        match *self {
            Actuator::Servo { channel, pwm_locked, pwm_released } => Action {
                cmd: MavCmd::MAV_CMD_DO_SET_SERVO,
                p1: channel as f32,
                p2: if release { pwm_released } else { pwm_locked } as f32,
            },
            Actuator::Relay { relay } => Action { cmd: MavCmd::MAV_CMD_DO_SET_RELAY, p1: relay as f32, p2: if release { 1.0 } else { 0.0 } },
        }
    }
}

pub struct Payload {
    pub store: Store,
    path: Option<PathBuf>,
    pub armed: bool,
    pub countdown: Option<Countdown>,
    epoch: u64,
    pub switch_mask: Option<u8>,
    switch_at_ms: u64,
    servo_pwm: HashMap<u8, u16>,
    /// Lançamentos esperando a chave confirmar: (número, compartimento, prazo).
    pending: Vec<(u32, u32, u64)>,
    /// Canais que a própria ponte mandou soltar, e quando (para não contar duas vezes).
    commanded: HashMap<u8, u64>,
    /// Último motivo de bloqueio ou aborto, mostrado no painel.
    pub last_message: Option<String>,
    /// Veículo em AUTO: soltura vista nas saídas é atribuída à missão.
    pub mission_mode: bool,
}

impl Payload {
    pub fn load(path: Option<PathBuf>) -> Self {
        let store = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| match serde_json::from_str::<Store>(&s) {
                Ok(st) => Some(st),
                Err(e) => {
                    tracing::warn!("entrega: arquivo de configuração inválido ({e}); usando o padrão");
                    None
                }
            })
            .unwrap_or_default();
        Self {
            store,
            path,
            armed: false,
            countdown: None,
            epoch: 0,
            switch_mask: None,
            switch_at_ms: 0,
            servo_pwm: HashMap::new(),
            pending: vec![],
            commanded: HashMap::new(),
            last_message: None,
            mission_mode: false,
        }
    }

    /// Grava o arquivo de forma atômica (escreve ao lado e renomeia).
    pub fn save(&self) {
        let Some(path) = &self.path else { return };
        let tmp = path.with_extension("json.tmp");
        let res = serde_json::to_vec_pretty(&self.store)
            .map_err(|e| e.to_string())
            .and_then(|b| std::fs::write(&tmp, b).map_err(|e| e.to_string()))
            .and_then(|_| std::fs::rename(&tmp, path).map_err(|e| e.to_string()));
        if let Err(e) = res {
            tracing::warn!("entrega: não foi possível gravar {}: {e}", path.display());
        }
    }

    pub fn slot(&self, id: u32) -> Option<&Slot> {
        self.store.slots.iter().find(|s| s.id == id)
    }

    fn slot_mut(&mut self, id: u32) -> Option<&mut Slot> {
        self.store.slots.iter_mut().find(|s| s.id == id)
    }

    fn switches_fresh(&self, now: u64) -> bool {
        self.switch_mask.is_some() && now.saturating_sub(self.switch_at_ms) < SWITCH_STALE_MS
    }

    /// Estado da chave de um compartimento: Some(true) = pino travado.
    pub fn switch_locked(&self, slot: &Slot, now: u64) -> Option<bool> {
        let bit = slot.switch_bit?;
        if !self.switches_fresh(now) {
            return None;
        }
        self.switch_mask.map(|m| m & (1 << bit) != 0)
    }

    /// Troca toda a configuração (lista de compartimentos e ajustes), validando antes.
    pub fn set_config(&mut self, mut slots: Vec<Slot>, settings: Settings) -> Result<(), String> {
        if self.countdown.is_some() {
            return Err("não dá para mudar a configuração durante a contagem".into());
        }
        validate(&slots, &settings)?;
        // Contadores e estado de carga ficam com o compartimento (pelo id), não com o que veio da interface.
        for s in &mut slots {
            if let Some(old) = self.slot(s.id) {
                s.releases = old.releases;
                s.loaded = old.loaded;
            }
        }
        self.store.slots = slots;
        self.store.settings = settings;
        self.save();
        Ok(())
    }

    /// Verifica se os compartimentos podem ser soltos agora.
    pub fn check_release(&self, ids: &[u32], v: &VehicleNow) -> Result<(), String> {
        if ids.is_empty() {
            return Err("nenhum compartimento escolhido".into());
        }
        if !self.armed {
            return Err("sistema de entrega desarmado".into());
        }
        if !v.connected {
            return Err("sem conexão com o veículo".into());
        }
        let st = &self.store.settings;
        if st.require_armed && !v.armed {
            return Err("os motores precisam estar armados".into());
        }
        if st.min_alt_m > 0.0 && v.alt_rel < st.min_alt_m {
            return Err(format!("altura {:.1} m abaixo do mínimo de {:.1} m", v.alt_rel, st.min_alt_m));
        }
        let mut seen = vec![];
        for id in ids {
            if seen.contains(id) {
                return Err("compartimento repetido".into());
            }
            seen.push(*id);
            let s = self.slot(*id).ok_or_else(|| format!("compartimento {id} não existe"))?;
            if !s.enabled {
                return Err(format!("{} está desativado", s.name));
            }
            if !s.loaded {
                return Err(format!("{} está vazio", s.name));
            }
        }
        Ok(())
    }

    pub fn start_countdown(&mut self, ids: Vec<u32>, now: u64) -> Countdown {
        self.epoch += 1;
        let total_ms = self.store.settings.countdown_s as u64 * 1000;
        let c = Countdown { slots: ids, ends_at_ms: now + total_ms, total_ms, epoch: self.epoch };
        self.countdown = Some(c.clone());
        self.last_message = None;
        c
    }

    /// Cancela a contagem em andamento. Retorna true se havia uma.
    pub fn abort(&mut self, reason: &str) -> bool {
        if self.countdown.take().is_some() {
            self.epoch += 1;
            self.last_message = Some(format!("contagem abortada: {reason}"));
            true
        } else {
            false
        }
    }

    pub fn countdown_valid(&self, epoch: u64) -> bool {
        self.countdown.as_ref().is_some_and(|c| c.epoch == epoch)
    }

    pub fn finish_countdown(&mut self, epoch: u64) -> bool {
        if self.countdown_valid(epoch) {
            self.countdown = None;
            true
        } else {
            false
        }
    }

    /// Registra um lançamento no contador e no histórico.
    pub fn record(&mut self, id: u32, v: &VehicleNow, source: &str, now: u64) -> Option<ReleaseEvent> {
        let fresh = self.switches_fresh(now);
        let slot = self.slot_mut(id)?;
        slot.loaded = false;
        slot.releases += 1;
        let (name, mass, has_switch) = (slot.name.clone(), slot.mass_g, slot.switch_bit.is_some());
        if let Actuator::Servo { channel, .. } = slot.actuator
            && source == "estação" {
                self.commanded.insert(channel, now);
            }
        self.store.total += 1;
        let ev = ReleaseEvent {
            n: self.store.total,
            slot: id,
            name,
            t: now,
            lat: v.lat,
            lon: v.lon,
            alt_rel: v.alt_rel,
            groundspeed: v.groundspeed,
            mass_g: mass,
            source: source.into(),
            confirmed: None,
        };
        if has_switch && fresh {
            self.pending.push((ev.n, id, now + CONFIRM_MS));
        }
        self.store.log.push(ev.clone());
        if self.store.log.len() > LOG_MAX {
            let excess = self.store.log.len() - LOG_MAX;
            self.store.log.drain(..excess);
        }
        self.save();
        Some(ev)
    }

    fn set_confirmed(&mut self, n: u32, ok: bool) -> Option<ReleaseEvent> {
        let ev = self.store.log.iter_mut().rev().find(|e| e.n == n)?;
        ev.confirmed = Some(ok);
        let ev = ev.clone();
        self.save();
        Some(ev)
    }

    /// Nova leitura das chaves. Retorna lançamentos confirmados e se algo mudou.
    pub fn on_switches(&mut self, mask: u8, now: u64) -> (Vec<ReleaseEvent>, bool) {
        let prev = if self.switches_fresh(now) { self.switch_mask } else { None };
        self.switch_mask = Some(mask);
        self.switch_at_ms = now;
        let mut changed = prev != Some(mask);
        // Pino recolocado (chave fechou) → compartimento carregado de novo.
        let mut reloaded = false;
        for s in &mut self.store.slots {
            if let Some(bit) = s.switch_bit {
                let locked = mask & (1 << bit) != 0;
                let was = prev.map(|p| p & (1 << bit) != 0);
                if locked && was == Some(false) && !s.loaded {
                    s.loaded = true;
                    reloaded = true;
                }
                // Primeira leitura: chave fechada vale como carregado.
                if locked && was.is_none() && !s.loaded {
                    s.loaded = true;
                    reloaded = true;
                }
            }
        }
        if reloaded {
            changed = true;
            self.save();
        }
        // Confirmações: o pino saiu (bit apagou) dentro do prazo.
        let mut done = vec![];
        let pend = std::mem::take(&mut self.pending);
        for (n, id, deadline) in pend {
            let bit = self.slot(id).and_then(|s| s.switch_bit);
            match bit {
                Some(b) if mask & (1 << b) == 0 => {
                    if let Some(ev) = self.set_confirmed(n, true) {
                        done.push(ev);
                    }
                }
                Some(_) if now < deadline => self.pending.push((n, id, deadline)),
                Some(_) => {
                    if let Some(ev) = self.set_confirmed(n, false) {
                        done.push(ev);
                    }
                }
                None => {}
            }
        }
        let changed = changed || !done.is_empty();
        (done, changed)
    }

    /// Prazos de confirmação vencidos (quando as chaves param de responder).
    pub fn tick(&mut self, now: u64) -> Vec<ReleaseEvent> {
        let mut out = vec![];
        let pend = std::mem::take(&mut self.pending);
        for (n, id, deadline) in pend {
            if now >= deadline + SWITCH_STALE_MS {
                if let Some(ev) = self.set_confirmed(n, false) {
                    out.push(ev);
                }
            } else {
                self.pending.push((n, id, deadline));
            }
        }
        out
    }

    /// Leitura das saídas (SERVO_OUTPUT_RAW). Detecta lançamentos feitos fora da ponte,
    /// como itens DO_SET_SERVO de uma missão.
    pub fn on_servo_outputs(&mut self, pwm: &[u16; 16], v: &VehicleNow, now: u64) -> Vec<ReleaseEvent> {
        let mut found = vec![];
        let slots: Vec<(u32, u8, u16, u16)> = self
            .store
            .slots
            .iter()
            .filter_map(|s| match s.actuator {
                Actuator::Servo { channel, pwm_locked, pwm_released } => Some((s.id, channel, pwm_locked, pwm_released)),
                _ => None,
            })
            .collect();
        for (id, ch, _locked, released) in slots {
            if !(1..=16).contains(&ch) {
                continue;
            }
            let cur = pwm[ch as usize - 1];
            if cur == 0 || cur == u16::MAX {
                continue;
            }
            let prev = self.servo_pwm.insert(ch, cur);
            let is_rel = (cur as i32 - released as i32).abs() <= PWM_TOL;
            let was_rel = prev.is_some_and(|p| (p as i32 - released as i32).abs() <= PWM_TOL);
            if is_rel && prev.is_some() && !was_rel {
                let ours = self.commanded.get(&ch).is_some_and(|t| now.saturating_sub(*t) < 5000);
                if !ours {
                    let source = if self.mission_mode { "missão" } else { "externo" };
                    if let Some(ev) = self.record(id, v, source, now) {
                        found.push(ev);
                    }
                }
            }
        }
        found
    }

    /// Pulso em segundos depois do qual o atuador volta a travar (None = fica solto).
    pub fn relock_after(&self, id: u32) -> Option<f32> {
        let s = self.slot(id)?;
        let r = self.store.settings.relock_s;
        match s.actuator {
            Actuator::Relay { .. } => Some(if r > 0.0 { r } else { SOLENOID_PULSE_S }),
            Actuator::Servo { .. } => (r > 0.0).then_some(r),
        }
    }

    /// Marca um canal como movido pela ponte (teste, trava), para não virar lançamento "externo".
    pub fn note_commanded(&mut self, id: u32, now: u64) {
        if let Some(Actuator::Servo { channel, .. }) = self.slot(id).map(|s| s.actuator.clone()) {
            self.commanded.insert(channel, now);
        }
    }

    pub fn mark_loaded(&mut self, id: u32, loaded: bool) -> Result<(), String> {
        let s = self.slot_mut(id).ok_or("compartimento não existe")?;
        s.loaded = loaded;
        self.save();
        Ok(())
    }

    pub fn reset_counter(&mut self) {
        self.store.total = 0;
        self.store.log.clear();
        for s in &mut self.store.slots {
            s.releases = 0;
        }
        self.pending.clear();
        self.save();
    }

    /// Estado completo para a interface.
    pub fn view(&self, now: u64) -> Value {
        let slots: Vec<Value> = self
            .store
            .slots
            .iter()
            .map(|s| {
                let mut v = serde_json::to_value(s).unwrap_or_default();
                v["switch_locked"] = json!(self.switch_locked(s, now));
                if let Actuator::Servo { channel, .. } = s.actuator {
                    v["pwm"] = json!(self.servo_pwm.get(&channel));
                }
                v
            })
            .collect();
        let onboard_g: f32 = self.store.slots.iter().filter(|s| s.loaded && s.enabled).map(|s| s.mass_g).sum();
        let loaded = self.store.slots.iter().filter(|s| s.loaded && s.enabled).count();
        json!({
            "type": "payload",
            "armed": self.armed,
            "slots": slots,
            "settings": self.store.settings,
            "total": self.store.total,
            "loaded": loaded,
            "onboard_g": onboard_g,
            "switches_ok": self.switches_fresh(now),
            "countdown": self.countdown.as_ref().map(|c| json!({
                "slots": c.slots,
                "remaining_ms": c.ends_at_ms.saturating_sub(now),
                "total_ms": c.total_ms,
            })),
            "message": self.last_message,
            "log": self.store.log.iter().rev().take(200).collect::<Vec<_>>(),
        })
    }
}

pub fn validate(slots: &[Slot], st: &Settings) -> Result<(), String> {
    if slots.len() > 16 {
        return Err("no máximo 16 compartimentos".into());
    }
    let mut ids = vec![];
    let mut chans = vec![];
    let mut relays = vec![];
    let mut bits = vec![];
    for s in slots {
        let name = s.name.trim();
        if name.is_empty() || name.chars().count() > 24 {
            return Err("nome de compartimento vazio ou com mais de 24 letras".into());
        }
        if ids.contains(&s.id) {
            return Err(format!("id {} repetido", s.id));
        }
        ids.push(s.id);
        match s.actuator {
            Actuator::Servo { channel, pwm_locked, pwm_released } => {
                if !(1..=16).contains(&channel) {
                    return Err(format!("{name}: canal de servo deve ser de 1 a 16"));
                }
                if (1..=4).contains(&channel) {
                    return Err(format!("{name}: as saídas 1–4 são dos motores"));
                }
                if chans.contains(&channel) {
                    return Err(format!("{name}: saída {channel} já usada por outro compartimento"));
                }
                chans.push(channel);
                for p in [pwm_locked, pwm_released] {
                    if !(800..=2200).contains(&p) {
                        return Err(format!("{name}: PWM deve ficar entre 800 e 2200 µs"));
                    }
                }
                if (pwm_locked as i32 - pwm_released as i32).abs() < 2 * PWM_TOL {
                    return Err(format!("{name}: PWM travado e solto muito próximos"));
                }
            }
            Actuator::Relay { relay } => {
                if relay > 15 {
                    return Err(format!("{name}: relé deve ser de 0 a 15"));
                }
                if relays.contains(&relay) {
                    return Err(format!("{name}: relé {relay} já usado"));
                }
                relays.push(relay);
            }
        }
        if let Some(b) = s.switch_bit {
            if b > 7 {
                return Err(format!("{name}: chave deve ser de 0 a 7"));
            }
            if bits.contains(&b) {
                return Err(format!("{name}: chave {} já usada", b + 1));
            }
            bits.push(b);
        }
        if !(0.0..=20000.0).contains(&s.mass_g) {
            return Err(format!("{name}: massa fora de 0–20 000 g"));
        }
    }
    if st.countdown_s > 10 {
        return Err("contagem regressiva de no máximo 10 s".into());
    }
    if !(0.0..=500.0).contains(&st.min_alt_m) || !(0.0..=30.0).contains(&st.relock_s) || !(0.0..=10.0).contains(&st.salvo_interval_s) || !(0.0..=60.0).contains(&st.mission_hold_s) {
        return Err("ajuste fora da faixa".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flying() -> VehicleNow {
        VehicleNow { connected: true, armed: true, lat: -30.0, lon: -51.2, alt_rel: 20.0, groundspeed: 1.0 }
    }

    #[test]
    fn default_is_valid() {
        let s = Store::default();
        assert!(validate(&s.slots, &s.settings).is_ok());
    }

    #[test]
    fn rejects_motor_channel_and_duplicates() {
        let mut s = Store::default();
        s.slots[0].actuator = Actuator::Servo { channel: 2, pwm_locked: 1100, pwm_released: 1900 };
        assert!(validate(&s.slots, &s.settings).is_err());
        let mut s = Store::default();
        s.slots[1].actuator = s.slots[0].actuator.clone();
        assert!(validate(&s.slots, &s.settings).is_err());
        let mut s = Store::default();
        s.slots[1].switch_bit = Some(0);
        assert!(validate(&s.slots, &s.settings).is_err());
    }

    #[test]
    fn release_interlocks() {
        let mut p = Payload::load(None);
        let v = flying();
        assert!(p.check_release(&[1], &v).unwrap_err().contains("desarmado"));
        p.armed = true;
        assert!(p.check_release(&[1], &v).unwrap_err().contains("vazio"));
        p.mark_loaded(1, true).unwrap();
        assert!(p.check_release(&[1], &v).is_ok());
        assert!(p.check_release(&[1, 1], &v).is_err());
        let low = VehicleNow { alt_rel: 2.0, ..v };
        assert!(p.check_release(&[1], &low).unwrap_err().contains("mínimo"));
        let ground = VehicleNow { armed: false, ..v };
        assert!(p.check_release(&[1], &ground).unwrap_err().contains("armados"));
        assert!(p.check_release(&[9], &v).is_err());
    }

    #[test]
    fn countdown_abort_and_generation() {
        let mut p = Payload::load(None);
        let c = p.start_countdown(vec![1], 1000);
        assert_eq!(c.ends_at_ms, 4000);
        assert!(p.countdown_valid(c.epoch));
        assert!(p.abort("teste"));
        assert!(!p.countdown_valid(c.epoch));
        assert!(!p.finish_countdown(c.epoch));
        let c2 = p.start_countdown(vec![1], 5000);
        assert!(p.finish_countdown(c2.epoch));
        assert!(p.countdown.is_none());
    }

    #[test]
    fn counter_and_switch_confirmation() {
        let mut p = Payload::load(None);
        let v = flying();
        // Chaves 1 e 2 travadas: primeira leitura marca como carregado.
        p.on_switches(0b0011, 1000);
        assert!(p.slot(1).unwrap().loaded && p.slot(2).unwrap().loaded && !p.slot(3).unwrap().loaded);
        let ev = p.record(1, &v, "estação", 1100).unwrap();
        assert_eq!(ev.n, 1);
        assert!(!p.slot(1).unwrap().loaded);
        // Pino saiu → confirmado.
        let (done, _) = p.on_switches(0b0010, 1500);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].confirmed, Some(true));
        // Compartimento 2 solto mas a chave não abre → falha após o prazo.
        let ev2 = p.record(2, &v, "estação", 2000).unwrap();
        assert_eq!(ev2.n, 2);
        let (done, _) = p.on_switches(0b0010, 2500);
        assert!(done.is_empty());
        let (done, _) = p.on_switches(0b0010, 2000 + CONFIRM_MS + 1);
        assert_eq!(done[0].confirmed, Some(false));
        assert_eq!(p.store.total, 2);
        assert_eq!(p.slot(1).unwrap().releases, 1);
        // Pino recolocado no 1 → carregado de novo.
        p.on_switches(0b0011, 6000);
        assert!(p.slot(1).unwrap().loaded);
        p.reset_counter();
        assert_eq!(p.store.total, 0);
        assert!(p.store.log.is_empty());
    }

    #[test]
    fn detects_mission_release_from_servo_output() {
        let mut p = Payload::load(None);
        p.mission_mode = true;
        p.mark_loaded(2, true).unwrap();
        let v = flying();
        let mut pwm = [1500u16; 16];
        pwm[5] = 1100; // canal 6 = ENT2 travado
        assert!(p.on_servo_outputs(&pwm, &v, 1000).is_empty());
        pwm[5] = 1900;
        let ev = p.on_servo_outputs(&pwm, &v, 1200);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].source, "missão");
        assert_eq!(ev[0].slot, 2);
        // Soltura comandada pela ponte não conta duas vezes.
        p.mark_loaded(1, true).unwrap();
        p.record(1, &v, "estação", 2000).unwrap();
        pwm[4] = 1100;
        p.on_servo_outputs(&pwm, &v, 2050);
        pwm[4] = 1900;
        assert!(p.on_servo_outputs(&pwm, &v, 2100).is_empty());
        assert_eq!(p.store.total, 2);
    }

    #[test]
    fn config_keeps_counters() {
        let mut p = Payload::load(None);
        p.mark_loaded(1, true).unwrap();
        p.record(1, &flying(), "estação", 10).unwrap();
        let mut slots = p.store.slots.clone();
        slots[0].name = "Kit médico".into();
        slots[0].releases = 0;
        slots.push(Slot { id: 7, name: "SOL1".into(), actuator: Actuator::Relay { relay: 2 }, switch_bit: None, mass_g: 500.0, enabled: true, loaded: false, releases: 0 });
        p.set_config(slots, Settings::default()).unwrap();
        assert_eq!(p.slot(1).unwrap().releases, 1);
        assert_eq!(p.slot(1).unwrap().name, "Kit médico");
        assert_eq!(p.relock_after(7), Some(3.0));
        let a = p.slot(7).unwrap().actuator.action(true);
        assert_eq!((a.cmd, a.p1, a.p2), (MavCmd::MAV_CMD_DO_SET_RELAY, 2.0, 1.0));
    }
}
