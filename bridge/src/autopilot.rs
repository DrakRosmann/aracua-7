//! Piloto automático no estilo de avião (painel de modos: HDG, NAV, ALT, V/S, SPD).
//!
//! Tudo roda no modo GUIDED do ArduPilot, a não ser NAV, que é a missão (AUTO):
//! * asa fixa e VTOL em voo horizontal: `MAV_CMD_GUIDED_CHANGE_HEADING`, `_ALTITUDE` e
//!   `_SPEED` (ArduPlane 4.5+), reenviados a cada 3 s para resistir a perda no rádio;
//! * multirrotor e helicóptero: `SET_POSITION_TARGET_LOCAL_NED` com velocidade e rumo a
//!   5 Hz (o ArduCopter para sozinho se ficar 3 s sem receber).
//!
//! ALT segura a altitude em que foi apertado; V/S sobe ou desce até a ALT SEL no ritmo
//! escolhido e captura (vira ALT) ao chegar. Sai sozinho, avisando, se o modo do veículo
//! mudar por outro motivo (failsafe, rádio, outra estação), se desarmar ou se a conexão cair.

use crate::state::Telemetry;
use aracua_bridge::modes::VehicleClass;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Tempo para o veículo entrar no modo pedido antes de o piloto automático desistir.
const MODE_GRACE_MS: u64 = 2500;
/// Reenvio dos comandos do avião (o ArduPlane guarda o alvo, mas o rádio pode perder um).
const RESEND_MS: u64 = 3000;
/// Velocidade vertical máxima no ALT do multirrotor (m/s).
const COPTER_ALT_RATE: f32 = 2.5;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Lateral {
    #[default]
    Hdg,
    Nav,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Vertical {
    #[default]
    Alt,
    Vs,
    Nav,
}

/// O que a ponte precisa mandar ao veículo.
#[derive(Debug, PartialEq, Clone)]
pub enum Action {
    Mode(&'static str),
    Heading(f32),
    /// Altitude relativa ao home (m) e ritmo (m/s; 0 = o máximo do avião).
    Altitude { alt: f32, rate: f32 },
    Airspeed(f32),
    /// Velocidade NED (m/s) e rumo (graus).
    Velocity { vn: f32, ve: f32, vd: f32, yaw: f32 },
}

/// Pedido da interface: só os campos presentes mudam.
#[derive(Deserialize, Debug, Default)]
pub struct Patch {
    #[serde(default)]
    pub engage: Option<bool>,
    #[serde(default)]
    pub lateral: Option<Lateral>,
    #[serde(default)]
    pub vertical: Option<Vertical>,
    #[serde(default)]
    pub hdg: Option<f32>,
    #[serde(default)]
    pub alt: Option<f32>,
    #[serde(default)]
    pub vs: Option<f32>,
    #[serde(default)]
    pub spd: Option<f32>,
    #[serde(default)]
    pub spd_on: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Autopilot {
    pub engaged: bool,
    pub lateral: Lateral,
    pub vertical: Vertical,
    /// HDG SEL (graus).
    pub hdg: f32,
    /// ALT SEL (m acima do home) e a altitude que o ALT está segurando.
    pub alt_sel: f32,
    pub alt_hold: f32,
    /// Ritmo do V/S (m/s, sempre positivo: o sentido é o da ALT SEL).
    pub vs: f32,
    /// Velocidade: no avião, ar (com `spd_on`, senão a de cruzeiro); no multirrotor, solo.
    pub spd: f32,
    pub spd_on: bool,
    /// Por que desligou sozinho (a interface avisa); `None` se foi o operador.
    pub message: Option<String>,
    #[serde(skip)]
    wing: bool,
    #[serde(skip)]
    mode_sent_ms: u64,
    #[serde(skip)]
    sent_ms: u64,
}

impl Default for Autopilot {
    fn default() -> Self {
        Autopilot {
            engaged: false, lateral: Lateral::Hdg, vertical: Vertical::Alt, hdg: 0.0, alt_sel: 50.0, alt_hold: 50.0,
            vs: 2.0, spd: 5.0, spd_on: false, message: None, wing: false, mode_sent_ms: 0, sent_ms: 0,
        }
    }
}

fn wrap360(d: f32) -> f32 {
    d.rem_euclid(360.0)
}

impl Autopilot {
    fn expected_mode(&self) -> &'static str {
        if self.lateral == Lateral::Nav { "AUTO" } else { "GUIDED" }
    }

    fn mode(&mut self, now: u64) -> Action {
        self.mode_sent_ms = now;
        self.sent_ms = 0;
        Action::Mode(self.expected_mode())
    }

    fn disengage(&mut self, reason: Option<String>) {
        self.engaged = false;
        self.message = reason;
    }

    /// Pedido da interface. Com o piloto desligado, os valores ficam pré-selecionados.
    pub fn command(&mut self, p: Patch, t: &Telemetry, class: VehicleClass, params: &BTreeMap<String, f32>, now: u64) -> Result<Vec<Action>, String> {
        let mut out = vec![];
        if p.engage == Some(false) {
            if self.engaged {
                self.disengage(None);
                // Desligar não larga o veículo: multirrotor segura a posição, avião circula.
                out.push(Action::Mode("LOITER"));
            }
            return Ok(out);
        }
        if let Some(h) = p.hdg {
            self.hdg = wrap360(h.round());
        }
        if let Some(a) = p.alt {
            if !(1.0..=5000.0).contains(&a) {
                return Err("ALT SEL fora de 1–5000 m".into());
            }
            self.alt_sel = a;
        }
        if let Some(v) = p.vs {
            if !(0.2..=20.0).contains(&v) {
                return Err("V/S fora de 0,2–20 m/s".into());
            }
            self.vs = v;
        }
        if let Some(s) = p.spd {
            if !(0.0..=80.0).contains(&s) {
                return Err("velocidade fora de 0–80 m/s".into());
            }
            self.spd = s;
        }
        if let Some(on) = p.spd_on {
            self.spd_on = on;
        }

        if p.engage == Some(true) && !self.engaged {
            if class == VehicleClass::Rover {
                return Err("piloto automático é para veículos que voam".into());
            }
            if !t.connected {
                return Err("sem conexão com o veículo".into());
            }
            if !t.armed || t.alt_rel < 2.0 {
                return Err("piloto automático só em voo (armado, acima de 2 m)".into());
            }
            self.wing = class.fixed_wing();
            // Liga segurando o que o veículo está fazendo: rumo, altitude e velocidade atuais.
            if p.hdg.is_none() {
                self.hdg = wrap360(t.heading.round());
            }
            self.alt_hold = t.alt_rel.round();
            if p.alt.is_none() {
                self.alt_sel = self.alt_hold;
            }
            if p.spd.is_none() {
                self.spd = if self.wing {
                    params.get("AIRSPEED_CRUISE").copied().unwrap_or(t.airspeed).round()
                } else {
                    (t.groundspeed * 2.0).round() / 2.0
                };
            }
            self.lateral = Lateral::Hdg;
            self.vertical = Vertical::Alt;
            self.engaged = true;
            self.message = None;
            out.push(self.mode(now));
        }
        if !self.engaged {
            if let Some(l) = p.lateral {
                self.lateral = l;
            }
            if let Some(v) = p.vertical {
                self.vertical = v;
            }
            return Ok(out);
        }

        match p.lateral {
            Some(Lateral::Nav) if self.lateral != Lateral::Nav => {
                self.lateral = Lateral::Nav;
                self.vertical = Vertical::Nav;
                out.push(self.mode(now));
            }
            Some(Lateral::Hdg) if self.lateral == Lateral::Nav => {
                self.lateral = Lateral::Hdg;
                if p.hdg.is_none() {
                    self.hdg = wrap360(t.heading.round());
                }
                self.leave_vnav(t);
                out.push(self.mode(now));
            }
            _ => {}
        }
        match p.vertical {
            Some(Vertical::Alt) => {
                self.alt_hold = t.alt_rel.round();
                self.vertical = Vertical::Alt;
            }
            Some(Vertical::Vs) => self.vertical = Vertical::Vs,
            _ => {}
        }
        // Modo vertical pedido durante a missão: sai do NAV e segue no rumo atual.
        if self.lateral == Lateral::Nav && matches!(p.vertical, Some(Vertical::Alt | Vertical::Vs)) {
            self.lateral = Lateral::Hdg;
            self.hdg = wrap360(t.heading.round());
            out.push(self.mode(now));
        }
        // Qualquer mudança: o avião recebe os alvos de novo já no próximo passo.
        self.sent_ms = 0;
        Ok(out)
    }

    fn leave_vnav(&mut self, t: &Telemetry) {
        if self.vertical == Vertical::Nav {
            self.vertical = Vertical::Alt;
            self.alt_hold = t.alt_rel.round();
        }
    }

    /// Passo a 5 Hz: confere se continua valendo e calcula o que mandar.
    pub fn step(&mut self, t: &Telemetry, params: &BTreeMap<String, f32>, now: u64) -> Vec<Action> {
        if !self.engaged {
            return vec![];
        }
        if !t.connected {
            self.disengage(Some("conexão com o veículo perdida".into()));
            return vec![];
        }
        if !t.armed {
            self.disengage(Some("motores desarmados".into()));
            return vec![];
        }
        let expected = self.expected_mode();
        if t.mode != expected {
            if now.saturating_sub(self.mode_sent_ms) > MODE_GRACE_MS {
                self.disengage(Some(format!("o veículo saiu para {}", t.mode)));
            }
            return vec![];
        }
        if self.lateral == Lateral::Nav {
            return vec![];
        }
        // Captura da ALT SEL no V/S.
        let capture = if self.wing { 2.0 } else { 0.5 };
        if self.vertical == Vertical::Vs && (self.alt_sel - t.alt_rel).abs() < capture {
            self.vertical = Vertical::Alt;
            self.alt_hold = self.alt_sel;
            self.sent_ms = 0;
        }
        let (target, rate) = match self.vertical {
            Vertical::Vs => (self.alt_sel, self.vs),
            _ => (self.alt_hold, 0.0),
        };
        if self.wing {
            if self.sent_ms != 0 && now.saturating_sub(self.sent_ms) < RESEND_MS {
                return vec![];
            }
            self.sent_ms = now;
            let speed = if self.spd_on { Some(self.spd) } else { params.get("AIRSPEED_CRUISE").copied() };
            let mut out = vec![Action::Heading(self.hdg), Action::Altitude { alt: target, rate }];
            out.extend(speed.map(Action::Airspeed));
            out
        } else {
            let max = if rate > 0.0 { rate } else { COPTER_ALT_RATE };
            let climb = ((target - t.alt_rel) * 0.8).clamp(-max, max);
            let h = self.hdg.to_radians();
            vec![Action::Velocity { vn: self.spd * h.cos(), ve: self.spd * h.sin(), vd: -climb, yaw: self.hdg }]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flying(mode: &str) -> Telemetry {
        Telemetry { connected: true, armed: true, alt_rel: 40.0, heading: 92.4, groundspeed: 0.2, airspeed: 17.0, mode: mode.into(), ..Default::default() }
    }
    fn on(p: Patch) -> Patch {
        Patch { engage: Some(true), ..p }
    }
    const NO: BTreeMap<String, f32> = BTreeMap::new();

    #[test]
    fn liga_segurando_o_estado_atual() {
        let mut ap = Autopilot::default();
        let acts = ap.command(on(Patch::default()), &flying("LOITER"), VehicleClass::Copter, &NO, 1000).unwrap();
        assert_eq!(acts, vec![Action::Mode("GUIDED")]);
        assert!(ap.engaged);
        assert_eq!((ap.hdg, ap.alt_hold, ap.alt_sel, ap.spd), (92.0, 40.0, 40.0, 0.0));
        // No chão ou desarmado: recusa.
        let mut ap = Autopilot::default();
        let t = Telemetry { alt_rel: 0.5, ..flying("LOITER") };
        assert!(ap.command(on(Patch::default()), &t, VehicleClass::Copter, &NO, 0).is_err());
        assert!(ap.command(on(Patch::default()), &flying("HOLD"), VehicleClass::Rover, &NO, 0).is_err());
    }

    #[test]
    fn multirrotor_voa_no_rumo_e_captura_a_altitude() {
        let mut ap = Autopilot::default();
        ap.command(on(Patch { hdg: Some(90.0), spd: Some(6.0), ..Default::default() }), &flying("LOITER"), VehicleClass::Copter, &NO, 0).unwrap();
        // Enquanto o modo não troca, espera.
        assert!(ap.step(&flying("LOITER"), &NO, 500).is_empty());
        let Action::Velocity { vn, ve, vd, yaw } = ap.step(&flying("GUIDED"), &NO, 600)[0] else { panic!() };
        assert!(vn.abs() < 1e-4 && (ve - 6.0).abs() < 1e-4 && vd.abs() < 1e-4 && yaw == 90.0);
        // V/S para 60 m a 1,5 m/s: sobe limitado ao ritmo e vira ALT perto do alvo.
        ap.command(Patch { alt: Some(60.0), vs: Some(1.5), vertical: Some(Vertical::Vs), ..Default::default() }, &flying("GUIDED"), VehicleClass::Copter, &NO, 700).unwrap();
        let Action::Velocity { vd, .. } = ap.step(&flying("GUIDED"), &NO, 800)[0] else { panic!() };
        assert_eq!(vd, -1.5);
        let near = Telemetry { alt_rel: 59.7, ..flying("GUIDED") };
        ap.step(&near, &NO, 900);
        assert_eq!((ap.vertical, ap.alt_hold), (Vertical::Alt, 60.0));
    }

    #[test]
    fn aviao_manda_rumo_altitude_e_velocidade_e_reenvia() {
        let params = BTreeMap::from([("AIRSPEED_CRUISE".to_string(), 18.0)]);
        let mut ap = Autopilot::default();
        ap.command(on(Patch::default()), &flying("FBWA"), VehicleClass::Plane, &params, 0).unwrap();
        assert_eq!(ap.spd, 18.0);
        let acts = ap.step(&flying("GUIDED"), &params, 100);
        assert_eq!(acts, vec![Action::Heading(92.0), Action::Altitude { alt: 40.0, rate: 0.0 }, Action::Airspeed(18.0)]);
        assert!(ap.step(&flying("GUIDED"), &params, 1000).is_empty());
        assert_eq!(ap.step(&flying("GUIDED"), &params, 3200).len(), 3);
        // Mudar o rumo manda na hora; com SPD ligado, a velocidade escolhida.
        ap.command(Patch { hdg: Some(-90.0), spd: Some(22.0), spd_on: Some(true), ..Default::default() }, &flying("GUIDED"), VehicleClass::Plane, &params, 3300).unwrap();
        assert_eq!(ap.step(&flying("GUIDED"), &params, 3400), vec![Action::Heading(270.0), Action::Altitude { alt: 40.0, rate: 0.0 }, Action::Airspeed(22.0)]);
    }

    #[test]
    fn nav_e_volta_para_hdg() {
        let mut ap = Autopilot::default();
        ap.command(on(Patch::default()), &flying("LOITER"), VehicleClass::Copter, &NO, 0).unwrap();
        let acts = ap.command(Patch { lateral: Some(Lateral::Nav), ..Default::default() }, &flying("GUIDED"), VehicleClass::Copter, &NO, 100).unwrap();
        assert_eq!(acts, vec![Action::Mode("AUTO")]);
        assert_eq!(ap.vertical, Vertical::Nav);
        assert!(ap.step(&flying("AUTO"), &NO, 200).is_empty());
        // V/S durante a missão: sai para GUIDED no rumo atual.
        let acts = ap.command(Patch { vertical: Some(Vertical::Vs), ..Default::default() }, &flying("AUTO"), VehicleClass::Copter, &NO, 300).unwrap();
        assert_eq!(acts, vec![Action::Mode("GUIDED")]);
        assert_eq!((ap.lateral, ap.vertical), (Lateral::Hdg, Vertical::Vs));
    }

    #[test]
    fn desliga_sozinho_e_pelo_operador() {
        let mut ap = Autopilot::default();
        ap.command(on(Patch::default()), &flying("LOITER"), VehicleClass::Copter, &NO, 0).unwrap();
        ap.step(&flying("GUIDED"), &NO, 100);
        // Failsafe trocou para RTL: espera o prazo e desliga avisando.
        assert!(ap.step(&flying("RTL"), &NO, 1000).is_empty() && ap.engaged);
        ap.step(&flying("RTL"), &NO, 3000);
        assert!(!ap.engaged);
        assert_eq!(ap.message.as_deref(), Some("o veículo saiu para RTL"));
        // Operador: volta para LOITER, sem mensagem.
        ap.command(on(Patch::default()), &flying("RTL"), VehicleClass::Copter, &NO, 4000).unwrap();
        assert_eq!(ap.command(Patch { engage: Some(false), ..Default::default() }, &flying("GUIDED"), VehicleClass::Copter, &NO, 4100).unwrap(), vec![Action::Mode("LOITER")]);
        assert!(!ap.engaged && ap.message.is_none());
        // Desarmado ou sem conexão.
        ap.command(on(Patch::default()), &flying("LOITER"), VehicleClass::Copter, &NO, 5000).unwrap();
        ap.step(&Telemetry { armed: false, ..flying("GUIDED") }, &NO, 5100);
        assert_eq!(ap.message.as_deref(), Some("motores desarmados"));
        // Valores fora da faixa.
        assert!(ap.command(Patch { vs: Some(50.0), ..Default::default() }, &flying("GUIDED"), VehicleClass::Copter, &NO, 0).is_err());
    }
}
