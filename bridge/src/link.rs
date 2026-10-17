//! Conexão MAVLink compartilhada: envio de mensagens, gravação do voo (.tlog) e
//! reprodução de voos gravados.
//!
//! O formato .tlog é o do Mission Planner/MAVProxy: para cada mensagem, 8 bytes com o
//! instante em microssegundos desde a época Unix (big-endian) seguidos do quadro MAVLink.

use aracua_bridge::{apm::*, now_ms, GCS_COMPONENT_ID, GCS_SYSTEM_ID};
use mavlink::{MavConnection, MavHeader};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

type RecvResult = Result<(MavHeader, MavMessage), mavlink::error::MessageReadError>;

enum Source {
    Live(mavlink::Connection<MavMessage>),
    Replay(Mutex<ReplayReader>),
}

pub struct Link {
    src: Source,
    seq: Mutex<u8>,
    target_system: AtomicU8,
    target_component: AtomicU8,
    log_dir: Option<PathBuf>,
    log: Mutex<Option<(PathBuf, BufWriter<File>)>>,
    /// A pasta de logs falhou uma vez: não tenta de novo a cada mensagem.
    log_off: AtomicBool,
    /// Controle da reprodução (só no modo reprodução).
    pub replay: Option<ReplayCtl>,
}

impl Link {
    pub fn new(conn: mavlink::Connection<MavMessage>, log_dir: Option<PathBuf>) -> Self {
        let mut conn = conn;
        conn.set_protocol_version(mavlink::MavlinkVersion::V2);
        Self::with(Source::Live(conn), log_dir, None)
    }

    /// Reproduz um voo gravado. Nada é enviado; os comandos ficam desligados.
    pub fn replay(path: &Path, speed: f32) -> anyhow::Result<Self> {
        let reader = ReplayReader::open(path)?;
        let ctl = ReplayCtl::new(path, reader.first_us, reader.last_us, speed);
        Ok(Self::with(Source::Replay(Mutex::new(reader)), None, Some(ctl)))
    }

    fn with(src: Source, log_dir: Option<PathBuf>, replay: Option<ReplayCtl>) -> Self {
        Self {
            src,
            seq: Mutex::new(0),
            target_system: AtomicU8::new(1),
            target_component: AtomicU8::new(1),
            log_dir,
            log: Mutex::new(None),
            log_off: AtomicBool::new(false),
            replay,
        }
    }

    pub fn is_replay(&self) -> bool {
        self.replay.is_some()
    }

    pub fn recv(&self) -> RecvResult {
        match &self.src {
            Source::Live(c) => {
                let r = c.recv();
                if let Ok((h, m)) = &r {
                    self.record(h, m);
                }
                r
            }
            Source::Replay(r) => r.lock().unwrap().next(self.replay.as_ref().unwrap()),
        }
    }

    pub fn set_target(&self, sys: u8, comp: u8) {
        self.target_system.store(sys, Ordering::Relaxed);
        self.target_component.store(comp, Ordering::Relaxed);
    }

    pub fn target(&self) -> (u8, u8) {
        (self.target_system.load(Ordering::Relaxed), self.target_component.load(Ordering::Relaxed))
    }

    pub fn send(&self, msg: &MavMessage) {
        let Source::Live(conn) = &self.src else { return };
        let sequence = {
            let mut s = self.seq.lock().unwrap();
            *s = s.wrapping_add(1);
            *s
        };
        let header = MavHeader { system_id: GCS_SYSTEM_ID, component_id: GCS_COMPONENT_ID, sequence };
        if let Err(e) = conn.send(&header, msg) {
            tracing::debug!("falha ao enviar {:?}: {e}", std::mem::discriminant(msg));
        }
        self.record(&header, msg);
    }

    // ---------- gravação ----------

    /// Grava a mensagem no .tlog do voo. O arquivo é criado na primeira mensagem.
    fn record(&self, h: &MavHeader, m: &MavMessage) {
        let Some(dir) = &self.log_dir else { return };
        if self.log_off.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = self.log.lock().unwrap();
        if guard.is_none() {
            let path = dir.join(format!("{}.tlog", file_stamp(now_ms())));
            match std::fs::create_dir_all(dir).and_then(|_| File::create(&path)) {
                Ok(f) => {
                    tracing::info!("gravando o voo em {}", path.display());
                    *guard = Some((path, BufWriter::new(f)));
                }
                Err(e) => {
                    tracing::warn!("não foi possível gravar o voo em {}: {e}", dir.display());
                    self.log_off.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
        if let Some((_, w)) = guard.as_mut() {
            let _ = w.write_all(&(now_ms() * 1000).to_be_bytes());
            let _ = mavlink::write_v2_msg(w, *h, m);
        }
    }

    pub fn flush_log(&self) {
        if let Some((_, w)) = self.log.lock().unwrap().as_mut() {
            let _ = w.flush();
        }
    }

    pub fn log_file(&self) -> Option<String> {
        self.log.lock().unwrap().as_ref().map(|(p, _)| p.display().to_string())
    }

    pub fn command_long(&self, command: MavCmd, p: [f32; 7]) {
        let (ts, tc) = self.target();
        self.send(&MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
            param1: p[0],
            param2: p[1],
            param3: p[2],
            param4: p[3],
            param5: p[4],
            param6: p[5],
            param7: p[6],
            command,
            target_system: ts,
            target_component: tc,
            confirmation: 0,
        }));
    }

    /// COMMAND_INT, para os comandos que o ArduPilot só aceita nele (os GUIDED_CHANGE_* do avião).
    pub fn command_int(&self, command: MavCmd, frame: MavFrame, p: [f32; 4], z: f32) {
        let (ts, tc) = self.target();
        self.send(&MavMessage::COMMAND_INT(COMMAND_INT_DATA {
            param1: p[0],
            param2: p[1],
            param3: p[2],
            param4: p[3],
            x: 0,
            y: 0,
            z,
            command,
            target_system: ts,
            target_component: tc,
            frame,
            current: 0,
            autocontinue: 0,
        }));
    }

    pub fn heartbeat(&self) {
        self.send(&MavMessage::HEARTBEAT(HEARTBEAT_DATA {
            custom_mode: 0,
            mavtype: MavType::MAV_TYPE_GCS,
            autopilot: MavAutopilot::MAV_AUTOPILOT_INVALID,
            base_mode: MavModeFlag::empty(),
            system_status: MavState::MAV_STATE_ACTIVE,
            mavlink_version: 3,
        }));
    }

    /// Pede ao ArduPilot que envie todos os fluxos de telemetria a 10 Hz.
    pub fn request_streams(&self) {
        let (ts, tc) = self.target();
        self.send(&MavMessage::REQUEST_DATA_STREAM(REQUEST_DATA_STREAM_DATA {
            req_message_rate: 10,
            target_system: ts,
            target_component: tc,
            req_stream_id: 0, // MAV_DATA_STREAM_ALL
            start_stop: 1,
        }));
        // Mensagens que não fazem parte dos fluxos padrão.
        for (id, hz) in [(242.0, 0.5), (241.0, 2.0), (147.0, 1.0), (65.0, 5.0)] {
            // HOME_POSITION, VIBRATION, BATTERY_STATUS, RC_CHANNELS
            self.command_long(MavCmd::MAV_CMD_SET_MESSAGE_INTERVAL, [id, 1e6 / hz, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
    }
}

/// "2026-10-16_14-03-27" (UTC) a partir de milissegundos Unix.
pub fn file_stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Data civil a partir dos dias desde 1970 (algoritmo de Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}_{:02}-{:02}-{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------- reprodução ----------

/// Estado da reprodução, compartilhado entre o leitor e os comandos da interface.
pub struct ReplayCtl {
    pub file: String,
    pub first_us: u64,
    pub last_us: u64,
    speed_bits: AtomicU32,
    paused: AtomicBool,
    pub pos_us: AtomicU64,
    seek: Mutex<Option<f64>>,
}

impl ReplayCtl {
    fn new(path: &Path, first_us: u64, last_us: u64, speed: f32) -> Self {
        Self {
            file: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
            first_us,
            last_us,
            speed_bits: AtomicU32::new(speed.clamp(0.1, 64.0).to_bits()),
            paused: AtomicBool::new(false),
            pos_us: AtomicU64::new(first_us),
            seek: Mutex::new(None),
        }
    }
    pub fn speed(&self) -> f32 {
        f32::from_bits(self.speed_bits.load(Ordering::Relaxed))
    }
    pub fn set_speed(&self, s: f32) {
        self.speed_bits.store(s.clamp(0.1, 64.0).to_bits(), Ordering::Relaxed);
    }
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
    pub fn set_paused(&self, p: bool) {
        self.paused.store(p, Ordering::Relaxed);
    }
    /// Pula para `t` segundos desde o começo da gravação.
    pub fn seek(&self, t: f64) {
        *self.seek.lock().unwrap() = Some(t.max(0.0));
        self.set_paused(false);
    }
    pub fn duration_s(&self) -> f64 {
        self.last_us.saturating_sub(self.first_us) as f64 / 1e6
    }
    pub fn position_s(&self) -> f64 {
        self.pos_us.load(Ordering::Relaxed).saturating_sub(self.first_us) as f64 / 1e6
    }
}

/// Lê um .tlog inteiro para a memória e entrega as mensagens no ritmo original.
pub struct ReplayReader {
    data: Vec<u8>,
    pos: usize,
    pub first_us: u64,
    pub last_us: u64,
    /// (instante gravado, instante real, velocidade) que ancoram o ritmo.
    anchor: Option<(u64, Instant, f32)>,
    /// Avança sem esperar até este instante gravado (depois de pular).
    fast_until: u64,
}

/// Tamanho do quadro MAVLink que começa em `b[0]`, ou None se não for um quadro.
pub fn frame_len(b: &[u8]) -> Option<usize> {
    match *b.first()? {
        0xFD if b.len() >= 3 => Some(12 + b[1] as usize + if b[2] & 1 != 0 { 13 } else { 0 }),
        0xFE if b.len() >= 2 => Some(8 + b[1] as usize),
        _ => None,
    }
}

impl ReplayReader {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let data = std::fs::read(path)?;
        let mut r = Self { data, pos: 0, first_us: 0, last_us: 0, anchor: None, fast_until: 0 };
        let (mut first, mut last) = (None, 0);
        while let Some((ts, _)) = r.next_raw() {
            first.get_or_insert(ts);
            last = ts;
        }
        r.first_us = first.ok_or_else(|| anyhow::anyhow!("nenhuma mensagem MAVLink em {}", path.display()))?;
        r.last_us = last;
        r.pos = 0;
        Ok(r)
    }

    /// Próximo registro (instante, início e fim do quadro), sem decodificar; pula lixo.
    fn next_raw(&mut self) -> Option<(u64, (usize, usize))> {
        while self.pos + 8 < self.data.len() {
            let ts = u64::from_be_bytes(self.data[self.pos..self.pos + 8].try_into().unwrap());
            let start = self.pos + 8;
            match frame_len(&self.data[start..]) {
                Some(n) if start + n <= self.data.len() => {
                    self.pos = start + n;
                    return Some((ts, (start, start + n)));
                }
                _ => self.pos += 1, // fora de sincronia: procura o próximo registro
            }
        }
        None
    }

    fn next(&mut self, ctl: &ReplayCtl) -> RecvResult {
        loop {
            if let Some(t) = ctl.seek.lock().unwrap().take() {
                self.pos = 0;
                self.anchor = None;
                self.fast_until = ctl.first_us + (t * 1e6) as u64;
            }
            if ctl.paused() {
                self.anchor = None;
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            let rec_start = self.pos;
            let Some((ts, (a, b))) = self.next_raw() else {
                // Fim da gravação: fica pausado no último instante.
                ctl.set_paused(true);
                continue;
            };
            if ts >= self.fast_until {
                let speed = ctl.speed();
                match self.anchor {
                    Some((t0, i0, s0)) if s0 == speed => {
                        let due = i0 + Duration::from_secs_f64(ts.saturating_sub(t0) as f64 / 1e6 / speed as f64);
                        let now = Instant::now();
                        if due > now {
                            std::thread::sleep(due - now);
                        }
                    }
                    _ => self.anchor = Some((ts, Instant::now(), speed)),
                }
            }
            // Pausou ou pulou enquanto esperava: devolve a mensagem e não anda o relógio.
            if ctl.paused() || ctl.seek.lock().unwrap().is_some() {
                self.pos = rec_start;
                continue;
            }
            ctl.pos_us.store(ts, Ordering::Relaxed);
            let mut peek = mavlink::peek_reader::PeekReader::new(&self.data[a..b]);
            if let Ok(v) = mavlink::read_any_msg::<MavMessage, _>(&mut peek) {
                return Ok(v);
            }
            // mensagem de outro dialeto ou corrompida: segue
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carimbo_de_arquivo() {
        assert_eq!(file_stamp(0), "1970-01-01_00-00-00");
        assert_eq!(file_stamp(1_792_108_800_000), "2026-10-16_00-00-00");
        assert_eq!(file_stamp(951_782_400_000 + 3_723_000), "2000-02-29_01-02-03");
    }

    #[test]
    fn grava_e_le_tlog() {
        let dir = std::env::temp_dir().join(format!("aracua-tlog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.tlog");
        let mut buf = Vec::new();
        for i in 0..5u64 {
            buf.extend_from_slice(&(1_000_000 + i * 100_000).to_be_bytes());
            let hb = MavMessage::HEARTBEAT(HEARTBEAT_DATA { custom_mode: i as u32, ..Default::default() });
            mavlink::write_v2_msg(&mut buf, MavHeader { system_id: 1, component_id: 1, sequence: i as u8 }, &hb).unwrap();
        }
        buf.extend_from_slice(b"lixo no fim");
        std::fs::write(&path, &buf).unwrap();

        let link = Link::replay(&path, 64.0).unwrap();
        let ctl = link.replay.as_ref().unwrap();
        assert_eq!(ctl.first_us, 1_000_000);
        assert!((ctl.duration_s() - 0.4).abs() < 1e-9);
        for i in 0..5u32 {
            match link.recv().unwrap().1 {
                MavMessage::HEARTBEAT(h) => assert_eq!(h.custom_mode, i),
                _ => panic!("esperava HEARTBEAT"),
            }
        }
        // Pular volta ao instante pedido.
        ctl.seek(0.0);
        assert!(matches!(link.recv().unwrap().1, MavMessage::HEARTBEAT(h) if h.custom_mode == 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tamanho_de_quadro() {
        assert_eq!(frame_len(&[0xFD, 9, 0]), Some(21));
        assert_eq!(frame_len(&[0xFD, 9, 1]), Some(34));
        assert_eq!(frame_len(&[0xFE, 9]), Some(17));
        assert_eq!(frame_len(&[0x00]), None);
    }
}
