//! Registro de manutenção: tempo de voo e voos da aeronave, ciclos de cada bateria,
//! tarefas periódicas (por horas ou por voos) e anotações. A ponte conta os voos sozinha
//! (do armar ao desarmar, se ficou no ar) e grava tudo em `manutencao.json`.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;

/// Tempo mínimo no ar para contar como voo (testes de motor no chão não contam).
pub const MIN_FLIGHT_S: f64 = 5.0;
/// Histórico guardado.
const MAX_FLIGHTS: usize = 1000;
const MAX_NOTES: usize = 500;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Battery {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub cycles: u32,
    #[serde(default)]
    pub flight_s: f64,
    /// Ciclos depois dos quais a bateria deve ser aposentada (0 = sem limite).
    #[serde(default)]
    pub max_cycles: u32,
    #[serde(default)]
    pub retired: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Task {
    pub id: u32,
    pub name: String,
    /// A cada quantas horas de voo (0 = não conta horas).
    #[serde(default)]
    pub every_h: f64,
    /// A cada quantos voos (0 = não conta voos).
    #[serde(default)]
    pub every_flights: u32,
    /// Totais da aeronave quando a tarefa foi feita pela última vez.
    #[serde(default)]
    pub done_flight_s: f64,
    #[serde(default)]
    pub done_flights: u32,
    #[serde(default)]
    pub done_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Flight {
    pub n: u32,
    pub start: u64,
    pub duration_s: f64,
    pub max_alt: f64,
    pub distance_m: f64,
    #[serde(default)]
    pub battery: Option<u32>,
    #[serde(default)]
    pub vehicle: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Note {
    pub t: u64,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Store {
    #[serde(default)]
    pub airframe: String,
    #[serde(default)]
    pub flight_s: f64,
    #[serde(default)]
    pub flights: u32,
    #[serde(default)]
    pub arm_cycles: u32,
    #[serde(default)]
    pub batteries: Vec<Battery>,
    /// Bateria em uso: recebe o ciclo do próximo voo.
    #[serde(default)]
    pub active_battery: Option<u32>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub history: Vec<Flight>,
    #[serde(default)]
    pub notes: Vec<Note>,
}

impl Store {
    /// Tarefas sugeridas para um multirrotor ou avião pequeno.
    fn defaults() -> Self {
        let t = |id, name: &str, every_h, every_flights| Task { id, name: name.into(), every_h, every_flights, ..Default::default() };
        Store {
            airframe: "Aracuã-7".into(),
            batteries: vec![Battery { id: 1, name: "Bateria 1".into(), max_cycles: 300, ..Default::default() }],
            active_battery: Some(1),
            tasks: vec![
                t(1, "Inspecionar hélices e fixação dos motores", 0.0, 10),
                t(2, "Trocar hélices", 20.0, 0),
                t(3, "Conferir parafusos, braços e trem de pouso", 5.0, 0),
                t(4, "Limpar e inspecionar o LiDAR", 10.0, 0),
                t(5, "Testar o sistema de entrega no solo", 0.0, 20),
                t(6, "Rolamentos dos motores", 50.0, 0),
            ],
            ..Default::default()
        }
    }
}

/// Andamento do voo atual (do armar ao desarmar).
#[derive(Default)]
struct Current {
    start: u64,
    airborne_s: f64,
    max_alt: f64,
    distance_m: f64,
    last: Option<(f64, f64)>,
}

/// O que a manutenção precisa saber do veículo a cada passo.
pub struct Sample {
    pub connected: bool,
    pub armed: bool,
    pub airborne: bool,
    pub alt_rel: f64,
    pub lat: f64,
    pub lon: f64,
    pub vehicle: String,
}

pub struct Maintenance {
    pub store: Store,
    path: Option<PathBuf>,
    current: Option<Current>,
}

fn haversine(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let (dla, dlo) = ((b.0 - a.0).to_radians(), (b.1 - a.1).to_radians());
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * h.sqrt().min(1.0).asin()
}

impl Maintenance {
    pub fn load(path: Option<PathBuf>) -> Self {
        let store = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| match serde_json::from_str(&s) {
                Ok(v) => Some(v),
                Err(e) => {
                    tracing::warn!("manutenção: arquivo ilegível ({e}); começando do zero");
                    None
                }
            })
            .unwrap_or_else(Store::defaults);
        Self { store, path, current: None }
    }

    pub fn save(&self) {
        let Some(p) = &self.path else { return };
        let tmp = p.with_extension("json.tmp");
        let r = serde_json::to_vec_pretty(&self.store)
            .map_err(std::io::Error::other)
            .and_then(|b| std::fs::write(&tmp, b))
            .and_then(|_| std::fs::rename(&tmp, p));
        if let Err(e) = r {
            tracing::warn!("manutenção: não foi possível gravar {}: {e}", p.display());
        }
    }

    /// Um passo de `dt` segundos. Devolve o voo terminado, se terminou agora.
    pub fn step(&mut self, s: &Sample, dt: f64, now: u64) -> Option<Flight> {
        // Veículo sumiu armado: não fecha o voo (pode ser só o rádio); espera voltar.
        if !s.connected {
            return None;
        }
        match (&mut self.current, s.armed) {
            (None, true) => {
                self.current = Some(Current { start: now, ..Default::default() });
                self.store.arm_cycles += 1;
                None
            }
            (Some(c), true) => {
                if s.airborne {
                    c.airborne_s += dt;
                    c.max_alt = c.max_alt.max(s.alt_rel);
                    let here = (s.lat, s.lon);
                    if let Some(prev) = c.last {
                        let d = haversine(prev, here);
                        // Saltos de GPS não contam.
                        if d < 200.0 {
                            c.distance_m += d;
                        }
                    }
                    c.last = Some(here);
                }
                None
            }
            (Some(_), false) => {
                let c = self.current.take().unwrap();
                if c.airborne_s < MIN_FLIGHT_S {
                    self.save();
                    return None;
                }
                let st = &mut self.store;
                st.flights += 1;
                st.flight_s += c.airborne_s;
                if let Some(b) = st.active_battery.and_then(|id| st.batteries.iter_mut().find(|b| b.id == id)) {
                    b.cycles += 1;
                    b.flight_s += c.airborne_s;
                }
                let f = Flight {
                    n: st.flights,
                    start: c.start,
                    duration_s: c.airborne_s,
                    max_alt: c.max_alt,
                    distance_m: c.distance_m,
                    battery: st.active_battery,
                    vehicle: s.vehicle.clone(),
                };
                st.history.push(f.clone());
                if st.history.len() > MAX_FLIGHTS {
                    st.history.remove(0);
                }
                self.save();
                Some(f)
            }
            (None, false) => None,
        }
    }

    /// Substitui aeronave, baterias e tarefas (os totais e o histórico ficam).
    pub fn configure(&mut self, airframe: String, batteries: Vec<Battery>, active: Option<u32>, tasks: Vec<Task>) -> Result<(), String> {
        let airframe = airframe.trim().to_string();
        if airframe.is_empty() || airframe.len() > 60 {
            return Err("nome da aeronave vazio ou longo demais".into());
        }
        for (i, b) in batteries.iter().enumerate() {
            if b.name.trim().is_empty() {
                return Err("toda bateria precisa de nome".into());
            }
            if batteries[..i].iter().any(|o| o.id == b.id) {
                return Err(format!("bateria {} repetida", b.id));
            }
        }
        for (i, t) in tasks.iter().enumerate() {
            if t.name.trim().is_empty() {
                return Err("toda tarefa precisa de nome".into());
            }
            if t.every_h < 0.0 || !t.every_h.is_finite() || (t.every_h == 0.0 && t.every_flights == 0) {
                return Err(format!("{}: defina a cada quantas horas ou voos", t.name));
            }
            if tasks[..i].iter().any(|o| o.id == t.id) {
                return Err(format!("tarefa {} repetida", t.id));
            }
        }
        if let Some(a) = active
            && !batteries.iter().any(|b| b.id == a && !b.retired) {
                return Err("a bateria em uso não está na lista (ou está aposentada)".into());
            }
        let st = &mut self.store;
        st.airframe = airframe;
        st.batteries = batteries;
        st.active_battery = active;
        st.tasks = tasks;
        self.save();
        Ok(())
    }

    pub fn task_done(&mut self, id: u32, note: Option<String>, now: u64) -> Result<(), String> {
        let st = &mut self.store;
        let (fs, fl) = (st.flight_s, st.flights);
        let t = st.tasks.iter_mut().find(|t| t.id == id).ok_or("tarefa não existe")?;
        t.done_flight_s = fs;
        t.done_flights = fl;
        t.done_at = Some(now);
        let text = match note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
            Some(n) => format!("{} feita: {n}", t.name),
            None => format!("{} feita", t.name),
        };
        self.add_note(text, now)
    }

    pub fn add_note(&mut self, text: String, now: u64) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() || text.len() > 500 {
            return Err("anotação vazia ou longa demais".into());
        }
        let st = &mut self.store;
        st.notes.push(Note { t: now, text });
        if st.notes.len() > MAX_NOTES {
            st.notes.remove(0);
        }
        self.save();
        Ok(())
    }

    /// Estado para a interface, com o vencimento de cada tarefa já calculado.
    pub fn view(&self) -> serde_json::Value {
        let st = &self.store;
        let tasks: Vec<_> = st
            .tasks
            .iter()
            .map(|t| {
                let h = (st.flight_s - t.done_flight_s) / 3600.0;
                let f = st.flights.saturating_sub(t.done_flights);
                // Fração do intervalo já usada: >= 1 vence.
                let mut used: f64 = 0.0;
                if t.every_h > 0.0 {
                    used = used.max(h / t.every_h);
                }
                if t.every_flights > 0 {
                    used = used.max(f as f64 / t.every_flights as f64);
                }
                json!({"id":t.id,"name":t.name,"every_h":t.every_h,"every_flights":t.every_flights,
                    "since_h":h,"since_flights":f,"used":used,"due":used >= 1.0,"done_at":t.done_at,
                    "done_flight_s":t.done_flight_s,"done_flights":t.done_flights})
            })
            .collect();
        let flying = self.current.as_ref().map(|c| c.airborne_s);
        json!({
            "type":"maintenance","airframe":st.airframe,"flight_s":st.flight_s,"flights":st.flights,
            "arm_cycles":st.arm_cycles,"batteries":st.batteries,"active_battery":st.active_battery,"tasks":tasks,
            "history":st.history.iter().rev().take(100).collect::<Vec<_>>(),"notes":st.notes.iter().rev().take(100).collect::<Vec<_>>(),
            "flying_s":flying,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(armed: bool, airborne: bool, lat: f64) -> Sample {
        Sample { connected: true, armed, airborne, alt_rel: if airborne { 30.0 } else { 0.0 }, lat, lon: -46.6, vehicle: "copter".into() }
    }

    #[test]
    fn conta_voo_bateria_e_tarefas() {
        let mut m = Maintenance::load(None);
        assert!(m.store.tasks.len() >= 3);
        // Teste de motor no chão: arma e desarma sem voar.
        m.step(&sample(true, false, -23.5), 0.1, 0);
        assert!(m.step(&sample(false, false, -23.5), 0.1, 1).is_none());
        assert_eq!((m.store.flights, m.store.arm_cycles), (0, 1));
        // Voo de 120 s andando ~0,0001° por passo (~11 m).
        m.step(&sample(true, false, -23.5), 0.1, 10);
        for i in 0..1200 {
            m.step(&sample(true, true, -23.5 + i as f64 * 1e-5), 0.1, 10 + i);
        }
        let f = m.step(&sample(false, false, -23.488), 0.1, 2000).expect("voo registrado");
        assert!((f.duration_s - 120.0).abs() < 0.5);
        assert!((f.distance_m - 1333.0).abs() < 15.0, "{}", f.distance_m);
        assert_eq!(f.max_alt, 30.0);
        assert_eq!(m.store.flights, 1);
        assert_eq!(m.store.batteries[0].cycles, 1);
        // Tarefa "a cada 10 voos" usou 10 %.
        let v = m.view();
        let t1 = v["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap();
        assert!((t1["used"].as_f64().unwrap() - 0.1).abs() < 1e-9);
        m.task_done(1, Some("tudo ok".into()), 3000).unwrap();
        let v = m.view();
        let t1 = v["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 1).unwrap();
        assert_eq!(t1["used"].as_f64().unwrap(), 0.0);
        assert!(m.store.notes.last().unwrap().text.contains("tudo ok"));
    }

    #[test]
    fn vence_por_horas() {
        let mut m = Maintenance::load(None);
        m.store.flight_s = 21.0 * 3600.0;
        let v = m.view();
        let t2 = v["tasks"].as_array().unwrap().iter().find(|t| t["id"] == 2).unwrap();
        assert_eq!(t2["due"], true);
    }

    #[test]
    fn recusa_configuracao_ruim() {
        let mut m = Maintenance::load(None);
        assert!(m.configure("".into(), vec![], None, vec![]).is_err());
        let t = Task { id: 1, name: "x".into(), ..Default::default() };
        assert!(m.configure("A".into(), vec![], None, vec![t]).is_err());
        assert!(m.configure("A".into(), vec![], Some(9), vec![]).is_err());
        assert!(m.configure("A".into(), vec![Battery { id: 2, name: "B".into(), ..Default::default() }], Some(2), vec![]).is_ok());
    }

    #[test]
    fn grava_e_le() {
        let dir = std::env::temp_dir().join(format!("aracua-manut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("manutencao.json");
        let mut m = Maintenance::load(Some(p.clone()));
        m.add_note("trocado o GPS".into(), 5).unwrap();
        let m2 = Maintenance::load(Some(p));
        assert_eq!(m2.store.notes.last().unwrap().text, "trocado o GPS");
        let _ = std::fs::remove_dir_all(dir);
    }
}
