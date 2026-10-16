//! Geocerca do ArduPilot: polígonos e círculos de inclusão (o veículo tem de ficar dentro)
//! e de exclusão (não pode entrar). Vai para o veículo pelo protocolo de missão com
//! `mission_type = MAV_MISSION_TYPE_FENCE`; cada vértice de polígono é um item.

use crate::apm::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Circle {
    pub lat: f64,
    pub lon: f64,
    pub radius: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Fence {
    /// Áreas permitidas: o veículo tem de ficar dentro de todas.
    #[serde(default)]
    pub inclusion: Vec<Vec<Point>>,
    /// Áreas proibidas.
    #[serde(default)]
    pub exclusion: Vec<Vec<Point>>,
    #[serde(default)]
    pub circles_inclusion: Vec<Circle>,
    #[serde(default)]
    pub circles_exclusion: Vec<Circle>,
}

/// O ArduPilot aceita até 255 vértices por polígono (param1 é a contagem).
pub const MAX_VERTICES: usize = 255;

impl Fence {
    pub fn is_empty(&self) -> bool {
        self.inclusion.is_empty() && self.exclusion.is_empty() && self.circles_inclusion.is_empty() && self.circles_exclusion.is_empty()
    }

    pub fn has_polygons(&self) -> bool {
        !self.inclusion.is_empty() || !self.exclusion.is_empty() || !self.circles_inclusion.is_empty() || !self.circles_exclusion.is_empty()
    }

    /// Confere antes de enviar: polígonos com 3+ vértices, coordenadas válidas, raios positivos.
    pub fn validate(&self) -> Result<(), String> {
        for (kind, polys) in [("permitida", &self.inclusion), ("proibida", &self.exclusion)] {
            for (i, p) in polys.iter().enumerate() {
                if p.len() < 3 {
                    return Err(format!("área {kind} {} tem {} vértices (mínimo 3)", i + 1, p.len()));
                }
                if p.len() > MAX_VERTICES {
                    return Err(format!("área {kind} {} tem {} vértices (máximo {MAX_VERTICES})", i + 1, p.len()));
                }
                if p.iter().any(|v| !valid(v.lat, v.lon)) {
                    return Err(format!("área {kind} {} tem coordenada inválida", i + 1));
                }
            }
        }
        for c in self.circles_inclusion.iter().chain(&self.circles_exclusion) {
            if !valid(c.lat, c.lon) || !(c.radius > 0.0 && c.radius.is_finite()) {
                return Err("círculo de geocerca inválido".into());
            }
        }
        Ok(())
    }

    /// Itens no formato do ArduPilot.
    pub fn items(&self, target: (u8, u8)) -> Vec<MISSION_ITEM_INT_DATA> {
        let mut out = Vec::new();
        let mut push = |command: MavCmd, p1: f32, lat: f64, lon: f64| {
            out.push(MISSION_ITEM_INT_DATA {
                param1: p1,
                x: (lat * 1e7).round() as i32,
                y: (lon * 1e7).round() as i32,
                seq: out.len() as u16,
                command,
                target_system: target.0,
                target_component: target.1,
                frame: MavFrame::MAV_FRAME_GLOBAL,
                autocontinue: 1,
                mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
                ..Default::default()
            });
        };
        for (cmd, polys) in [
            (MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, &self.inclusion),
            (MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION, &self.exclusion),
        ] {
            for p in polys {
                for v in p {
                    push(cmd, p.len() as f32, v.lat, v.lon);
                }
            }
        }
        for c in &self.circles_inclusion {
            push(MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION, c.radius, c.lat, c.lon);
        }
        for c in &self.circles_exclusion {
            push(MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION, c.radius, c.lat, c.lon);
        }
        out
    }

    /// Caminho inverso: itens lidos do veículo. Itens desconhecidos (ponto de retorno) são ignorados.
    pub fn parse(items: &[MISSION_ITEM_INT_DATA]) -> Fence {
        let mut f = Fence::default();
        let mut i = 0;
        while i < items.len() {
            let it = &items[i];
            let (lat, lon) = (it.x as f64 / 1e7, it.y as f64 / 1e7);
            match it.command {
                MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION | MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION => {
                    let n = (it.param1.max(1.0) as usize).min(items.len() - i);
                    let poly: Vec<Point> = items[i..i + n]
                        .iter()
                        .take_while(|v| v.command == it.command)
                        .map(|v| Point { lat: v.x as f64 / 1e7, lon: v.y as f64 / 1e7 })
                        .collect();
                    i += poly.len().max(1);
                    if poly.len() >= 3 {
                        if it.command == MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION {
                            f.inclusion.push(poly);
                        } else {
                            f.exclusion.push(poly);
                        }
                    }
                    continue;
                }
                MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION => f.circles_inclusion.push(Circle { lat, lon, radius: it.param1 }),
                MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION => f.circles_exclusion.push(Circle { lat, lon, radius: it.param1 }),
                _ => {}
            }
            i += 1;
        }
        f
    }
}

fn valid(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0
}

/// Ponto dentro do polígono (lat/lon tratados como plano: bom para cercas de alguns km).
pub fn inside(p: Point, poly: &[Point]) -> bool {
    let mut c = false;
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + n - 1) % n]);
        if (a.lat > p.lat) != (b.lat > p.lat) && p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon {
            c = !c;
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(lat: f64, lon: f64, d: f64) -> Vec<Point> {
        vec![
            Point { lat: lat - d, lon: lon - d },
            Point { lat: lat - d, lon: lon + d },
            Point { lat: lat + d, lon: lon + d },
            Point { lat: lat + d, lon: lon - d },
        ]
    }

    #[test]
    fn ida_e_volta() {
        let f = Fence {
            inclusion: vec![square(-23.55, -46.63, 0.01)],
            exclusion: vec![square(-23.55, -46.63, 0.001), square(-23.555, -46.635, 0.0005)],
            circles_inclusion: vec![],
            circles_exclusion: vec![Circle { lat: -23.552, lon: -46.632, radius: 30.0 }],
        };
        f.validate().unwrap();
        let items = f.items((1, 1));
        assert_eq!(items.len(), 4 + 4 + 4 + 1);
        assert!(items.iter().all(|i| i.mission_type == MavMissionType::MAV_MISSION_TYPE_FENCE));
        assert_eq!(items[0].param1, 4.0);
        assert!(items.iter().enumerate().all(|(i, it)| it.seq as usize == i));
        let back = Fence::parse(&items);
        assert_eq!(back.inclusion.len(), 1);
        assert_eq!(back.exclusion.len(), 2);
        assert_eq!(back.circles_exclusion.len(), 1);
        assert!((back.inclusion[0][2].lat - f.inclusion[0][2].lat).abs() < 1e-6);
    }

    #[test]
    fn recusa_poligono_ruim() {
        let mut f = Fence { inclusion: vec![square(0.0, 0.0, 0.01)[..2].to_vec()], ..Default::default() };
        assert!(f.validate().is_err());
        f.inclusion = vec![vec![Point { lat: 95.0, lon: 0.0 }; 3]];
        assert!(f.validate().is_err());
    }

    #[test]
    fn dentro_e_fora() {
        let sq = square(-23.55, -46.63, 0.01);
        assert!(inside(Point { lat: -23.55, lon: -46.63 }, &sq));
        assert!(!inside(Point { lat: -23.53, lon: -46.63 }, &sq));
        // Côncavo (um "U"): o meio do U está fora.
        let u = vec![
            Point { lat: 0.0, lon: 0.0 }, Point { lat: 0.0, lon: 3.0 }, Point { lat: 3.0, lon: 3.0 }, Point { lat: 3.0, lon: 2.0 },
            Point { lat: 1.0, lon: 2.0 }, Point { lat: 1.0, lon: 1.0 }, Point { lat: 3.0, lon: 1.0 }, Point { lat: 3.0, lon: 0.0 },
        ];
        assert!(!inside(Point { lat: 2.0, lon: 1.5 }, &u));
        assert!(inside(Point { lat: 2.0, lon: 0.5 }, &u));
    }
}
