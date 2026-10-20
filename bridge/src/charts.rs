//! Cartas aeronáuticas para voos de longo alcance: aerovias, fixos, auxílios-rádio,
//! aeródromos e espaços aéreos. Vêm do GeoServer público do DECEA (o mesmo das cartas
//! ENRC do AISWEB) ou de um arquivo importado, num formato compacto que a interface
//! desenha no mapa e usa para montar rotas (ver docs/protocolo.md#cartas-aeronáuticas).
//! Ficam guardadas em `cartas.json`, para uso sem internet.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const FORMAT: &str = "aracua-charts";
pub const DECEA_URL: &str = "https://geoaisweb.decea.mil.br/geoserver/ows";

/// Camadas do GeoServer do DECEA e o que cada uma traz.
pub const DECEA_LAYERS: [(&str, &str); 8] = [
    ("vw_aerovia_baixa_v2", "aerovias inferiores"),
    ("vw_aerovia_alta_v2", "aerovias superiores"),
    ("waypoint", "fixos"),
    ("vor", "VOR"),
    ("dme", "DME"),
    ("ndb", "NDB"),
    ("airport", "aeródromos"),
    ("airspace", "espaços aéreos"),
];

/// Tipos de espaço aéreo guardados (os setores de controle e afins ficam de fora).
const AIRSPACE_KINDS: [&str; 12] = ["FIR", "UIR", "CTA", "UTA", "TMA", "CTR", "ATZ", "R", "P", "D", "AMA", "ADIZ"];

/// Limite vertical: valor, unidade (FT, FL ou M) e referência (SFC, MSL ou STD).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Limit {
    pub v: f32,
    pub u: String,
    pub r: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Fix {
    pub id: String,
    /// wpt, vor, vordme, dme ou ndb.
    pub kind: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freq: Option<String>,
    /// Declinação magnética em graus (positiva para leste).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub var: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Airport {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// Elevação em metros.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elev: Option<f32>,
    #[serde(default)]
    pub ifr: bool,
    /// Uso público (ou militar e público); os privados são a maioria e aparecem só de perto.
    #[serde(default)]
    pub public: bool,
}

/// Trecho de aerovia entre dois fixos.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Segment {
    pub airway: String,
    /// Aerovia superior (ENRC H); senão inferior (ENRC L).
    #[serde(default)]
    pub upper: bool,
    #[serde(default)]
    pub rnav: bool,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub seq: u32,
    /// both, fwd (só de `from` para `to`) ou back (só de `to` para `from`).
    #[serde(default = "both")]
    pub dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lo: Option<Limit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hi: Option<Limit>,
    /// Altitude mínima em rota publicada para o trecho.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mea: Option<Limit>,
    /// [lon, lat] de `from` até `to`.
    pub coords: Vec<[f64; 2]>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Airspace {
    pub id: String,
    /// FIR, UIR, CTA, UTA, TMA, CTR, ATZ, R (restrita), P (proibida), D (perigosa), AMA ou ADIZ.
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lo: Option<Limit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hi: Option<Limit>,
    /// Contorno externo, [lon, lat], fechado.
    pub ring: Vec<[f64; 2]>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Pack {
    pub format: String,
    pub version: u32,
    pub source: String,
    /// Quando foi baixado (ms desde a época Unix).
    #[serde(default)]
    pub fetched: u64,
    /// Emenda (ciclo AIRAC) em vigor e a próxima, AAAA-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(default)]
    pub fixes: Vec<Fix>,
    #[serde(default)]
    pub airports: Vec<Airport>,
    #[serde(default)]
    pub airways: Vec<Segment>,
    #[serde(default)]
    pub airspaces: Vec<Airspace>,
}

fn both() -> String {
    "both".into()
}

impl Pack {
    /// Confere o que veio de um arquivo: formato, coordenadas e tamanhos.
    pub fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT {
            return Err(format!("formato \"{}\" não é {FORMAT}", self.format));
        }
        if self.version != 1 {
            return Err(format!("versão {} do formato de cartas não suportada", self.version));
        }
        let ok = |lat: f64, lon: f64| (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon);
        if let Some(f) = self.fixes.iter().find(|f| !ok(f.lat, f.lon) || f.id.is_empty()) {
            return Err(format!("fixo inválido: {:?}", f.id));
        }
        if let Some(a) = self.airports.iter().find(|a| !ok(a.lat, a.lon) || a.id.is_empty()) {
            return Err(format!("aeródromo inválido: {:?}", a.id));
        }
        if let Some(s) = self.airways.iter().find(|s| s.coords.len() < 2 || s.coords.iter().any(|c| !ok(c[1], c[0]))) {
            return Err(format!("trecho de aerovia inválido: {} {}–{}", s.airway, s.from, s.to));
        }
        if let Some(a) = self.airspaces.iter().find(|a| a.ring.len() < 4 || a.ring.iter().any(|c| !ok(c[1], c[0]))) {
            return Err(format!("espaço aéreo inválido: {}", a.id));
        }
        Ok(())
    }

    pub fn counts(&self) -> Value {
        json!({"fixes": self.fixes.len(), "airports": self.airports.len(), "airways": self.airways.len(), "airspaces": self.airspaces.len()})
    }
}

// ---------- leitura das camadas do DECEA (GeoJSON do WFS) ----------

fn s(p: &Value, k: &str) -> Option<String> {
    match p.get(k)? {
        Value::String(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn f(p: &Value, k: &str) -> Option<f64> {
    match p.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(v) => v.trim().parse().ok(),
        _ => None,
    }
}

/// Datas do DECEA vêm como "2026-10-01Z".
fn date(p: &Value, k: &str) -> Option<String> {
    s(p, k).map(|d| d.trim_end_matches('Z').to_string())
}

fn round(v: f64, digits: i32) -> f64 {
    let m = 10f64.powi(digits);
    (v * m).round() / m
}

fn limit(v: Option<f64>, unit: Option<String>, reference: Option<String>) -> Option<Limit> {
    let v = v?;
    let u = unit.unwrap_or_else(|| "FT".into()).to_uppercase();
    let mut r = reference.unwrap_or_else(|| if u == "FL" { "STD".into() } else { "MSL".into() }).to_uppercase();
    if u == "FL" {
        r = "STD".into();
    }
    // Ilimitado (FL999) e "do solo" ficam como estão: a interface sabe ler.
    Some(Limit { v: v as f32, u, r })
}

/// Primeiro ponto de Point/MultiPoint ([lon, lat]).
fn point(feat: &Value) -> Option<(f64, f64)> {
    let g = feat.get("geometry")?;
    let c = g.get("coordinates")?;
    let c = if g.get("type")?.as_str()? == "MultiPoint" { c.get(0)? } else { c };
    Some((c.get(1)?.as_f64()?, c.get(0)?.as_f64()?))
}

fn coords(c: &Value) -> Vec<[f64; 2]> {
    c.as_array()
        .map(|a| a.iter().filter_map(|p| Some([round(p.get(0)?.as_f64()?, 4), round(p.get(1)?.as_f64()?, 4)])).collect())
        .unwrap_or_default()
}

/// Contornos externos de Polygon/MultiPolygon.
fn rings(feat: &Value) -> Vec<Vec<[f64; 2]>> {
    let Some(g) = feat.get("geometry") else { return vec![] };
    let c = &g["coordinates"];
    match g["type"].as_str() {
        Some("Polygon") => vec![coords(&c[0])],
        Some("MultiPolygon") => c.as_array().map(|ps| ps.iter().map(|p| coords(&p[0])).collect()).unwrap_or_default(),
        _ => vec![],
    }
}

fn features(layer: &Value) -> &[Value] {
    layer.get("features").and_then(|f| f.as_array()).map(|v| v.as_slice()).unwrap_or(&[])
}

fn props(feat: &Value) -> &Value {
    feat.get("properties").unwrap_or(&Value::Null)
}

fn segments(layer: &Value, upper: bool, out: &mut Vec<Segment>, dates: &mut (Option<String>, Option<String>)) {
    for ft in features(layer) {
        let p = props(ft);
        let (Some(airway), Some(from), Some(to)) = (s(p, "text_designator"), s(p, "from_fix_ident"), s(p, "to_fix_ident")) else { continue };
        let line = coords(&ft["geometry"]["coordinates"]);
        if line.len() < 2 {
            continue;
        }
        dates.0 = dates.0.take().or_else(|| date(p, "emenda"));
        dates.1 = dates.1.take().or_else(|| date(p, "emenda_futura"));
        out.push(Segment {
            airway,
            upper,
            rnav: s(p, "code_type").as_deref() == Some("RNAV"),
            from,
            to,
            seq: f(p, "sequence").unwrap_or(0.0) as u32,
            dir: match s(p, "direction").as_deref() {
                Some("FORWARD") => "fwd".into(),
                Some("BACKWARD") => "back".into(),
                _ => "both".into(),
            },
            lo: limit(f(p, "lower_limit"), s(p, "uom_lower_limit"), s(p, "code_vertical_distance_lower")),
            hi: limit(f(p, "upper_limit"), s(p, "uom_upper_limit"), s(p, "code_vertical_distance_upper")),
            mea: limit(f(p, "minimumn_level"), s(p, "uom_minimumn_level"), s(p, "code_vertical_distance_minimumn_level")),
            coords: line,
        });
    }
}

/// Monta as cartas a partir das camadas do DECEA (nome da camada → GeoJSON).
pub fn from_decea(layers: &HashMap<String, Value>, fetched: u64) -> Pack {
    let empty = Value::Null;
    let layer = |k: &str| layers.get(k).unwrap_or(&empty);
    let mut dates = (None, None);
    let mut airways = vec![];
    segments(layer("vw_aerovia_baixa_v2"), false, &mut airways, &mut dates);
    segments(layer("vw_aerovia_alta_v2"), true, &mut airways, &mut dates);
    airways.sort_by(|a, b| (a.upper, &a.airway, a.seq).cmp(&(b.upper, &b.airway, b.seq)));

    let mut fixes: Vec<Fix> = vec![];
    for ft in features(layer("vor")) {
        let p = props(ft);
        let (Some(id), Some((lat, lon))) = (s(p, "ident"), point(ft)) else { continue };
        fixes.push(Fix {
            id,
            kind: "vor".into(),
            lat: round(lat, 6),
            lon: round(lon, 6),
            name: s(p, "txtname"),
            freq: f(p, "frequency").map(|v| format!("{v:.2}")),
            var: f(p, "magvariati").map(|v| v as f32),
        });
    }
    for ft in features(layer("dme")) {
        let p = props(ft);
        let Some(id) = s(p, "ident").or_else(|| s(p, "codeid")) else { continue };
        let Some((lat, lon)) = point(ft) else { continue };
        // DME junto de um VOR de mesmo nome: vira VOR/DME.
        if let Some(v) = fixes.iter_mut().find(|v| v.kind == "vor" && v.id == id && (v.lat - lat).abs() < 0.02 && (v.lon - lon).abs() < 0.02) {
            v.kind = "vordme".into();
            continue;
        }
        fixes.push(Fix {
            id,
            kind: "dme".into(),
            lat: round(lat, 6),
            lon: round(lon, 6),
            name: s(p, "txtname"),
            freq: f(p, "valghostfr").map(|v| format!("{v:.2}")),
            var: f(p, "magneticva").map(|v| v as f32),
        });
    }
    for ft in features(layer("ndb")) {
        let p = props(ft);
        let Some(id) = s(p, "codeid").or_else(|| s(p, "ident")) else { continue };
        let Some((lat, lon)) = point(ft) else { continue };
        fixes.push(Fix {
            id,
            kind: "ndb".into(),
            lat: round(lat, 6),
            lon: round(lon, 6),
            name: s(p, "txtname"),
            freq: f(p, "valfreq").map(|v| format!("{v:.0}")),
            var: f(p, "valmagvar").map(|v| v as f32),
        });
    }
    for ft in features(layer("waypoint")) {
        let p = props(ft);
        let (Some(id), Some((lat, lon))) = (s(p, "ident"), point(ft)) else { continue };
        fixes.push(Fix { id, kind: "wpt".into(), lat: round(lat, 6), lon: round(lon, 6), name: None, freq: None, var: f(p, "magvariati").map(|v| (v * 10.0).round() as f32 / 10.0) });
    }

    let mut airports = vec![];
    for ft in features(layer("airport")) {
        let p = props(ft);
        let Some(id) = s(p, "localidade_id").or_else(|| s(p, "ciad")) else { continue };
        let Some((lat, lon)) = point(ft) else { continue };
        let usage = s(p, "tipo_util").unwrap_or_default();
        let elev = f(p, "elevacao").map(|e| if s(p, "elev_uom").as_deref() == Some("FT") { e * 0.3048 } else { e });
        airports.push(Airport {
            id,
            name: s(p, "nome").unwrap_or_default(),
            lat: round(lat, 6),
            lon: round(lon, 6),
            elev: elev.map(|e| e.round() as f32),
            ifr: s(p, "opr").is_some_and(|o| o.contains("IFR")),
            public: usage.contains("PUB"),
        });
    }

    let mut airspaces = vec![];
    let mut seen = HashSet::new();
    for ft in features(layer("airspace")) {
        let p = props(ft);
        let Some(mut kind) = s(p, "typ") else { continue };
        if kind == "CTA_P" {
            kind = "CTA".into();
        }
        if !AIRSPACE_KINDS.contains(&kind.as_str()) {
            continue;
        }
        let id = s(p, "ident").unwrap_or_default();
        let name = s(p, "nam").unwrap_or_else(|| id.clone());
        // Campos do DECEA: superior = upperlimit/uplimituni/codedistve; inferior = lowerlimi1/lowerlimit/codedistv1.
        let hi = limit(f(p, "upperlimit"), s(p, "uplimituni"), s(p, "codedistve"));
        let lo = limit(f(p, "lowerlimi1"), s(p, "lowerlimit"), s(p, "codedistv1"));
        for (i, ring) in rings(ft).into_iter().enumerate() {
            if ring.len() < 4 || !seen.insert((id.clone(), kind.clone(), i, ring.len())) {
                continue;
            }
            airspaces.push(Airspace { id: id.clone(), kind: kind.clone(), name: name.clone(), lo: lo.clone(), hi: hi.clone(), ring });
        }
    }

    Pack {
        format: FORMAT.into(),
        version: 1,
        source: "DECEA (AISWEB)".into(),
        fetched,
        effective: dates.0,
        next: dates.1,
        fixes,
        airports,
        airways,
        airspaces,
    }
}

/// Baixa uma camada do WFS do DECEA em GeoJSON (bloqueante).
pub fn fetch_layer(base: &str, layer: &str) -> Result<Value, String> {
    let url = format!("{base}?service=WFS&version=1.0.0&request=GetFeature&typeName=ICA:{layer}&outputFormat=application/json");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(180)))
        .user_agent(concat!("aracua-bridge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut resp = agent.get(&url).call().map_err(|e| format!("{layer}: {e}"))?;
    resp.body_mut().with_config().limit(200 * 1024 * 1024).read_json::<Value>().map_err(|e| format!("{layer}: resposta inválida ({e})"))
}

// ---------- cartas guardadas na ponte ----------

#[derive(Default)]
pub struct Charts {
    pub file: Option<PathBuf>,
    pack: Option<Pack>,
    /// Mensagem `charts` pronta (é grande: monta uma vez só).
    message: Option<Arc<String>>,
    pub busy: bool,
    pub error: Option<String>,
}

impl Charts {
    pub fn load(file: Option<PathBuf>) -> Self {
        let mut c = Charts { file, ..Default::default() };
        let Some(path) = &c.file else { return c };
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<Pack>(&bytes).map_err(|e| e.to_string()).and_then(|p| p.validate().map(|_| p)) {
                Ok(p) => {
                    tracing::info!("cartas: {} ({}, {} trechos de aerovia)", path.display(), p.source, p.airways.len());
                    c.set(p);
                }
                Err(e) => tracing::warn!("cartas: {} ilegível: {e}", path.display()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("cartas: {}: {e}", path.display()),
        }
        c
    }

    fn set(&mut self, p: Pack) {
        let mut v = serde_json::to_value(&p).unwrap_or_default();
        v["type"] = json!("charts");
        self.message = Some(Arc::new(v.to_string()));
        self.pack = Some(p);
    }

    /// Troca as cartas e grava no arquivo.
    pub fn replace(&mut self, p: Pack) -> Result<(), String> {
        p.validate()?;
        if let Some(path) = &self.file {
            let tmp = path.with_extension("json.tmp");
            let data = serde_json::to_vec(&p).map_err(|e| e.to_string())?;
            std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("gravando {}: {e}", path.display()))?;
        }
        self.set(p);
        self.error = None;
        Ok(())
    }

    pub fn clear(&mut self) {
        self.pack = None;
        self.message = None;
        if let Some(path) = &self.file {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Mensagem `charts` completa, para mandar só a quem pediu.
    pub fn message(&self) -> Option<Arc<String>> {
        self.message.clone()
    }

    /// Resumo (`charts_info`), mandado a todas as interfaces.
    pub fn info(&self) -> Value {
        let p = self.pack.as_ref();
        json!({
            "type": "charts_info",
            "loaded": p.is_some(),
            "id": p.map(|p| p.fetched),
            "source": p.map(|p| p.source.clone()),
            "fetched": p.map(|p| p.fetched),
            "effective": p.and_then(|p| p.effective.clone()),
            "next": p.and_then(|p| p.next.clone()),
            "counts": p.map(|p| p.counts()),
            "bytes": self.message.as_ref().map(|m| m.len()),
            "busy": self.busy,
            "error": self.error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fc(features: Value) -> Value {
        json!({"type": "FeatureCollection", "features": features})
    }

    fn sample() -> HashMap<String, Value> {
        let mut l = HashMap::new();
        l.insert("vw_aerovia_baixa_v2".into(), fc(json!([{
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-43.65171, -19.602], [-44.0485, -19.5582]]},
            "properties": {"text_designator": "Z73", "code_type": "RNAV", "sequence": 70, "direction": "FORWARD",
                "lower_limit": 155, "uom_lower_limit": "FL", "code_vertical_distance_lower": "STD",
                "upper_limit": 245, "uom_upper_limit": "FL", "from_fix_ident": "MUKDI", "to_fix_ident": "CNF",
                "minimumn_level": null, "emenda": "2026-10-01Z", "emenda_futura": "2026-10-29Z"}
        }])));
        l.insert("vw_aerovia_alta_v2".into(), fc(json!([{
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-56.8913, -29.5345], [-57.522, -25.2442]]},
            "properties": {"text_designator": "UM402", "code_type": "RNAV", "sequence": 20, "direction": "BOTH",
                "lower_limit": 245, "uom_lower_limit": "FL", "upper_limit": 999, "uom_upper_limit": "FL",
                "from_fix_ident": "KIMIK", "to_fix_ident": "VAS"}
        }])));
        l.insert("vor".into(), fc(json!([
            {"geometry": {"type": "MultiPoint", "coordinates": [[-57.522, -25.244166667]]},
             "properties": {"ident": "VAS", "txtname": "ASUNCION", "frequency": 115.9, "magvariati": -13.07}},
        ])));
        l.insert("dme".into(), fc(json!([
            {"geometry": {"type": "MultiPoint", "coordinates": [[-57.5221, -25.2442]]}, "properties": {"ident": "VAS"}},
            {"geometry": {"type": "MultiPoint", "coordinates": [[-40.0, -10.0]]}, "properties": {"ident": "XYZ"}},
        ])));
        l.insert("ndb".into(), fc(json!([
            {"geometry": {"type": "MultiPoint", "coordinates": [[-49.0697, -22.1688]]}, "properties": {"codeid": "ARE", "txtname": "AREALVA", "valfreq": 340}},
        ])));
        l.insert("waypoint".into(), fc(json!([
            {"geometry": {"type": "MultiPoint", "coordinates": [[-39.0528, 4.366]]}, "properties": {"ident": "VUREM", "magvariati": -18.016633902}},
            {"geometry": null, "properties": {"ident": "SEMGEO"}},
        ])));
        l.insert("airport".into(), fc(json!([
            {"geometry": {"type": "MultiPoint", "coordinates": [[-46.6556, -23.6261]]},
             "properties": {"localidade_id": "SBSP", "nome": "Congonhas", "elevacao": 802, "elev_uom": "M", "opr": "VFR IFR", "tipo_util": "PUB"}},
            {"geometry": {"type": "MultiPoint", "coordinates": [[-52.11, -9.72]]},
             "properties": {"localidade_id": "SI90", "nome": "Fazenda", "elevacao": 268.85, "opr": "VFR DIURNA", "tipo_util": "PRIV"}},
        ])));
        l.insert("airspace".into(), fc(json!([
            {"geometry": {"type": "Polygon", "coordinates": [[[-39.0, -14.0], [-38.0, -14.0], [-38.0, -15.0], [-39.0, -14.0]]]},
             "properties": {"typ": "TMA", "ident": "SBWL", "nam": "Ilhéus", "codedistve": "STD", "uplimituni": "FL", "upperlimit": 195,
                "codedistv1": "MSL", "lowerlimit": "FT", "lowerlimi1": 3500}},
            {"geometry": {"type": "Polygon", "coordinates": [[[-35.0, -9.0], [-35.1, -9.0], [-35.1, -9.1], [-35.0, -9.0]]]},
             "properties": {"typ": "R", "ident": "SBR881", "nam": "PARAMOTOR", "codedistve": "MSL", "uplimituni": "FT", "upperlimit": 500,
                "codedistv1": "SFC", "lowerlimit": "FT", "lowerlimi1": 0}},
            {"geometry": {"type": "Polygon", "coordinates": [[[-35.0, -9.0], [-35.1, -9.0], [-35.1, -9.1], [-35.0, -9.0]]]},
             "properties": {"typ": "SECTOR", "ident": "SETOR1"}},
            {"geometry": null, "properties": {"typ": "R", "ident": "SBR000"}},
        ])));
        l
    }

    #[test]
    fn monta_cartas_do_decea() {
        let p = from_decea(&sample(), 123);
        p.validate().unwrap();
        assert_eq!(p.effective.as_deref(), Some("2026-10-01"));
        assert_eq!(p.next.as_deref(), Some("2026-10-29"));
        assert_eq!(p.airways.len(), 2);
        let z = &p.airways[0];
        assert_eq!((z.airway.as_str(), z.from.as_str(), z.to.as_str(), z.dir.as_str(), z.upper, z.rnav), ("Z73", "MUKDI", "CNF", "fwd", false, true));
        assert_eq!(z.lo, Some(Limit { v: 155.0, u: "FL".into(), r: "STD".into() }));
        assert_eq!(z.coords[0], [-43.6517, -19.602]);
        assert!(z.mea.is_none());
        assert!(p.airways[1].upper);
        // VAS tem DME junto: vira VOR/DME; XYZ fica só DME.
        let vas = p.fixes.iter().find(|f| f.id == "VAS").unwrap();
        assert_eq!((vas.kind.as_str(), vas.freq.as_deref()), ("vordme", Some("115.90")));
        assert_eq!(p.fixes.iter().filter(|f| f.id == "VAS").count(), 1);
        assert_eq!(p.fixes.iter().find(|f| f.id == "XYZ").unwrap().kind, "dme");
        assert_eq!(p.fixes.iter().find(|f| f.id == "ARE").unwrap().freq.as_deref(), Some("340"));
        let vurem = p.fixes.iter().find(|f| f.id == "VUREM").unwrap();
        assert_eq!((vurem.kind.as_str(), vurem.var), ("wpt", Some(-18.0)));
        assert!(!p.fixes.iter().any(|f| f.id == "SEMGEO"));
        let sbsp = &p.airports[0];
        assert!(sbsp.ifr && sbsp.public && sbsp.elev == Some(802.0));
        assert!(!p.airports[1].ifr && !p.airports[1].public);
        // Setores ficam de fora; o espaço sem geometria também.
        assert_eq!(p.airspaces.len(), 2);
        let tma = &p.airspaces[0];
        assert_eq!(tma.hi, Some(Limit { v: 195.0, u: "FL".into(), r: "STD".into() }));
        assert_eq!(tma.lo, Some(Limit { v: 3500.0, u: "FT".into(), r: "MSL".into() }));
        assert_eq!(p.airspaces[1].lo.as_ref().unwrap().r, "SFC");
    }

    #[test]
    fn validacao_recusa_lixo() {
        let mut p = from_decea(&sample(), 1);
        p.format = "outro".into();
        assert!(p.validate().is_err());
        let mut p = from_decea(&sample(), 1);
        p.fixes[0].lat = 123.0;
        assert!(p.validate().is_err());
        let mut p = from_decea(&sample(), 1);
        p.airways[0].coords.truncate(1);
        assert!(p.validate().is_err());
    }

    #[test]
    fn guarda_e_recarrega() {
        let dir = std::env::temp_dir().join(format!("aracua-charts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cartas.json");
        let mut c = Charts::load(Some(file.clone()));
        assert_eq!(c.info()["loaded"], json!(false));
        c.replace(from_decea(&sample(), 42)).unwrap();
        let again = Charts::load(Some(file.clone()));
        let info = again.info();
        assert_eq!(info["id"], json!(42));
        assert_eq!(info["counts"]["airways"], json!(2));
        let msg: Value = serde_json::from_str(&again.message().unwrap()).unwrap();
        assert_eq!(msg["type"], json!("charts"));
        assert_eq!(msg["airways"][0]["airway"], json!("Z73"));
        let mut again = again;
        again.clear();
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
