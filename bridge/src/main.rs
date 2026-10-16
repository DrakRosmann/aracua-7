//! aracua-bridge: MAVLink ↔ WebSocket para a estação de solo Aracuã-7.
// O ArduPilot ainda usa várias mensagens marcadas como obsoletas no padrão
// MAVLink (REQUEST_DATA_STREAM, MISSION_REQUEST, frames *_INT, MOUNT_CONTROL).
#![allow(deprecated)]

mod commands;
mod link;
mod mission;
mod payload;
mod state;

use aracua_bridge::{apm::MavMessage, mapframe, now_ms};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMsg;

#[derive(Parser, Debug)]
#[command(version, about = "Ponte MAVLink ↔ WebSocket da estação de solo Aracuã-7")]
struct Args {
    /// Endereço MAVLink: udpin:IP:PORTA, udpout:IP:PORTA, tcpout:IP:PORTA ou serial:/dev/ttyUSB0:57600
    #[arg(long, default_value = "udpin:0.0.0.0:14550")]
    mavlink: String,
    /// Endereço do servidor WebSocket para a interface. Só esta máquina por padrão;
    /// use 0.0.0.0:8765 para tablets na rede (aí a ponte exige token).
    #[arg(long, default_value = "127.0.0.1:8765")]
    ws: String,
    /// Token exigido das interfaces (ws://host:8765/?token=...). Sem ele e escutando
    /// na rede, a ponte gera um e mostra no log.
    #[arg(long, env = "ARACUA_TOKEN")]
    token: Option<String>,
    /// Pasta onde cada voo é gravado em .tlog
    #[arg(long, default_value = "logs")]
    log_dir: PathBuf,
    /// Não grava o voo
    #[arg(long)]
    no_log: bool,
    /// Reproduz um voo gravado (.tlog) em vez de conectar no veículo
    #[arg(long)]
    replay: Option<PathBuf>,
    /// Velocidade da reprodução (1 = tempo real)
    #[arg(long, default_value_t = 1.0)]
    replay_speed: f32,
    /// Porta UDP onde chegam os quadros do mapa LiDAR (nó map_link do ROS 2)
    #[arg(long, default_value = "0.0.0.0:14600")]
    map_udp: String,
    /// Arquivo com a configuração dos compartimentos de entrega, o contador e o histórico
    #[arg(long, default_value = "entrega.json")]
    payload_file: PathBuf,
    /// Sai quando a entrada padrão fechar (usado pelo app desktop)
    #[arg(long)]
    exit_with_parent: bool,
}

#[derive(Clone)]
pub enum Out {
    Text(Arc<String>),
    Binary(Arc<Vec<u8>>),
}

/// Limite do histórico de mapa guardado para clientes que conectam depois.
const MAP_HISTORY_MAX_BYTES: usize = 64 * 1024 * 1024;

pub struct Shared {
    pub link: link::Link,
    pub state: Mutex<state::State>,
    pub mission: Mutex<mission::Uploader>,
    pub downloader: Mutex<mission::Downloader>,
    /// O que está no veículo, pelo último download ou envio.
    pub vehicle_mission: Mutex<Option<mission::VehicleMission>>,
    pub payload: Mutex<payload::Payload>,
    pub tx: broadcast::Sender<Out>,
    pub clients: AtomicUsize,
    map_history: Mutex<(Vec<Arc<Vec<u8>>>, usize)>,
}

impl Shared {
    pub fn emit(&self, v: serde_json::Value) {
        let _ = self.tx.send(Out::Text(Arc::new(v.to_string())));
    }
    /// Envia o estado do sistema de entrega para todas as interfaces.
    pub fn emit_payload(&self) {
        let v = self.payload.lock().unwrap().view(now_ms());
        self.emit(v);
    }
    /// Dados do veículo usados pelas travas de segurança e pelo histórico de lançamentos.
    pub fn vehicle_now(&self) -> payload::VehicleNow {
        let s = self.state.lock().unwrap();
        payload::VehicleNow {
            connected: s.t.connected,
            armed: s.t.armed,
            lat: s.t.lat,
            lon: s.t.lon,
            alt_rel: s.t.alt_rel,
            groundspeed: s.t.groundspeed,
        }
    }
    /// Estado da reprodução de voo gravado, se houver.
    pub fn emit_replay(&self) {
        if let Some(r) = &self.link.replay {
            self.emit(json!({
                "type": "replay", "file": r.file, "t": r.position_s(), "duration": r.duration_s(),
                "speed": r.speed(), "paused": r.paused(),
            }));
        }
    }
    fn mission_view(&self) -> Option<serde_json::Value> {
        let m = self.vehicle_mission.lock().unwrap().clone()?;
        let mut v = serde_json::to_value(&m).ok()?;
        v["type"] = json!("vehicle_mission");
        Some(v)
    }
    /// Missão no veículo mudou (download ou envio aceito): guarda e avisa as interfaces.
    fn set_vehicle_mission(&self, items: &[aracua_bridge::apm::MISSION_ITEM_INT_DATA]) {
        let slots = self.payload.lock().unwrap().store.slots.clone();
        *self.vehicle_mission.lock().unwrap() = Some(mission::parse(items, &slots));
        if let Some(v) = self.mission_view() {
            self.emit(v);
        }
    }
    fn on_upload(&self, out: mission::Outcome) {
        if let mission::Outcome::Done { ok, result, count, wp_seq } = out {
            tracing::info!("envio de missão: {result}");
            self.emit(json!({"type":"mission_upload","ok":ok,"result":result,"count":count,"wp_seq":wp_seq}));
            if ok {
                let items = self.mission.lock().unwrap().items().to_vec();
                self.set_vehicle_mission(&items);
            }
        }
    }
    fn on_download(&self, out: mission::Download) {
        if let mission::Download::Done(r) = out {
            match r {
                Ok(items) => {
                    tracing::info!("missão lida do veículo: {} itens", items.len());
                    self.set_vehicle_mission(&items);
                }
                Err(e) => {
                    tracing::warn!("download da missão: {e}");
                    self.emit(json!({"type":"error","message":format!("download da missão: {e}")}));
                }
            }
        }
    }
    pub fn reset_map(&self) {
        *self.map_history.lock().unwrap() = (Vec::new(), 0);
        self.emit(json!({"type": "map_reset"}));
    }
}

fn receive_loop(shared: Arc<Shared>) {
    let mut have_target = false;
    loop {
        let (hdr, msg) = match shared.link.recv() {
            Ok(v) => v,
            Err(e) => {
                tracing::trace!("leitura MAVLink: {e}");
                continue;
            }
        };
        if let MavMessage::HEARTBEAT(h) = &msg
            && hdr.component_id == 1 && h.mavtype != aracua_bridge::apm::MavType::MAV_TYPE_GCS {
                shared.link.set_target(hdr.system_id, hdr.component_id);
                if !have_target {
                    have_target = true;
                    tracing::info!("veículo encontrado: sistema {} ({:?})", hdr.system_id, h.autopilot);
                    shared.link.request_streams();
                    // O que o veículo já tem na memória (ponte reiniciada em voo, outro GCS…).
                    if !shared.link.is_replay() {
                        shared.downloader.lock().unwrap().start(&shared.link);
                    }
                    // Leva todos os compartimentos para "travado": posição conhecida desde o início.
                    let locks: Vec<_> = {
                        let mut p = shared.payload.lock().unwrap();
                        let ids: Vec<u32> = p.store.slots.iter().filter(|s| s.enabled).map(|s| s.id).collect();
                        for id in &ids {
                            p.note_commanded(*id, now_ms());
                        }
                        p.store.slots.iter().filter(|s| s.enabled).map(|s| s.actuator.action(false)).collect()
                    };
                    for a in locks {
                        shared.link.command_long(a.cmd, [a.p1, a.p2, 0.0, 0.0, 0.0, 0.0, 0.0]);
                    }
                }
            }
        payload_input(&shared, &msg);
        let event = shared.state.lock().unwrap().update(hdr.system_id, hdr.component_id, &msg);
        if let Some(ev) = event {
            shared.emit(match ev {
                state::Event::StatusText { severity, text } => json!({"type":"statustext","severity":severity,"text":text}),
                state::Event::Ack { command, result } => json!({"type":"ack","command":command,"result":result}),
                state::Event::Param { id, value, index, count } => json!({"type":"param","id":id,"value":value,"index":index,"count":count}),
                state::Event::Calib(mut v) => {
                    v["type"] = json!("calib");
                    v
                }
            });
        }
        let up = shared.mission.lock().unwrap().handle(&shared.link, &msg);
        shared.on_upload(up);
        let down = shared.downloader.lock().unwrap().handle(&shared.link, &msg);
        shared.on_download(down);
    }
}

/// Mensagens do veículo que interessam ao sistema de entrega.
fn payload_input(shared: &Shared, msg: &MavMessage) {
    match msg {
        MavMessage::NAMED_VALUE_FLOAT(n) if aracua_bridge::char_array_to_string(&n.name) == "ENT_SW" => {
            let mask = n.value.clamp(0.0, 255.0) as u8;
            let (done, changed) = shared.payload.lock().unwrap().on_switches(mask, now_ms());
            for ev in done {
                shared.emit(json!({"type":"payload_confirm","event":ev}));
            }
            if changed {
                shared.emit_payload();
            }
        }
        MavMessage::SERVO_OUTPUT_RAW(o) => {
            let pwm = [
                o.servo1_raw, o.servo2_raw, o.servo3_raw, o.servo4_raw, o.servo5_raw, o.servo6_raw, o.servo7_raw, o.servo8_raw,
                o.servo9_raw, o.servo10_raw, o.servo11_raw, o.servo12_raw, o.servo13_raw, o.servo14_raw, o.servo15_raw, o.servo16_raw,
            ];
            let v = shared.vehicle_now();
            let found = shared.payload.lock().unwrap().on_servo_outputs(&pwm, &v, now_ms());
            for ev in &found {
                tracing::info!("entrega: lançamento nº {} ({}) detectado nas saídas, origem {}", ev.n, ev.name, ev.source);
                shared.emit(json!({"type":"payload_release","event":ev}));
            }
            if !found.is_empty() {
                shared.emit_payload();
            }
        }
        _ => {}
    }
}

async fn periodic(shared: Arc<Shared>) {
    let mut telem = tokio::time::interval(Duration::from_millis(100));
    let mut tick: u64 = 0;
    loop {
        telem.tick().await;
        tick += 1;
        let snap = shared.state.lock().unwrap().snapshot();
        if tick.is_multiple_of(10) {
            shared.link.flush_log();
        }
        if let Some(r) = &shared.link.replay {
            if r.paused() {
                shared.state.lock().unwrap().hold_heartbeat();
            }
            if tick.is_multiple_of(5) {
                shared.emit_replay();
            }
        }
        if tick.is_multiple_of(10) && !shared.link.is_replay() {
            shared.link.heartbeat();
            // Se o veículo está conectado mas mudo, pede os fluxos de novo.
            if snap.connected && snap.msgs_per_sec < 5.0 && tick.is_multiple_of(50) {
                shared.link.request_streams();
            }
        }
        let up = shared.mission.lock().unwrap().tick(&shared.link);
        shared.on_upload(up);
        let down = shared.downloader.lock().unwrap().tick(&shared.link);
        shared.on_download(down);
        // Sistema de entrega: 10 Hz durante a contagem, 2 Hz no resto do tempo.
        let counting = {
            let mut p = shared.payload.lock().unwrap();
            p.mission_mode = snap.mode == "AUTO";
            for ev in p.tick(now_ms()) {
                shared.emit(json!({"type":"payload_confirm","event":ev}));
            }
            if p.armed && !snap.connected {
                p.armed = false;
                p.abort("conexão com o veículo perdida");
                p.last_message = Some("entrega desarmada: conexão com o veículo perdida".into());
            }
            p.countdown.is_some()
        };
        if counting || tick.is_multiple_of(5) {
            shared.emit_payload();
        }
        let mut v = serde_json::to_value(&snap).unwrap_or_default();
        v["type"] = json!("telemetry");
        v["t"] = json!(now_ms());
        shared.emit(v);
    }
}

async fn map_feed(shared: Arc<Shared>, addr: String) -> anyhow::Result<()> {
    let sock = UdpSocket::bind(&addr).await?;
    tracing::info!("aguardando mapa LiDAR em udp://{addr}");
    let mut buf = vec![0u8; 65536];
    loop {
        let (n, _) = sock.recv_from(&mut buf).await?;
        let frame = &buf[..n];
        let Some(decoded) = mapframe::decode(frame) else {
            tracing::debug!("quadro de mapa inválido ({n} bytes)");
            continue;
        };
        let data = Arc::new(frame.to_vec());
        if let mapframe::Frame::Voxels { reset, .. } = decoded {
            let mut h = shared.map_history.lock().unwrap();
            if reset {
                *h = (Vec::new(), 0);
            }
            if h.1 + n <= MAP_HISTORY_MAX_BYTES {
                h.1 += n;
                h.0.push(data.clone());
            }
        }
        let _ = shared.tx.send(Out::Binary(data));
    }
}

/// Comparação que leva o mesmo tempo para qualquer token (não vaza o prefixo certo).
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Token do pedido de conexão: `?token=...` na URL.
fn request_token(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|kv| kv.strip_prefix("token=")).map(|t| t.to_string())
}

/// Token aleatório de 128 bits em hexadecimal (sem dependências: SipHash com chave aleatória).
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        h.write_u64(i ^ std::process::id() as u64);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

async fn client(shared: Arc<Shared>, stream: tokio::net::TcpStream, mavlink_addr: String, token: Option<Arc<String>>) -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    let peer = stream.peer_addr()?;
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        match &token {
            Some(t) if !request_token(req.uri().query()).is_some_and(|got| same_token(&got, t)) => {
                tracing::warn!("{peer}: conexão recusada (token ausente ou errado)");
                let mut r = ErrorResponse::new(Some("token ausente ou errado: use ws://host:porta/?token=...".into()));
                *r.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                Err(r)
            }
            _ => Ok(resp),
        }
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, check).await?;
    tracing::info!("interface conectada: {peer}");
    let (mut sink, mut source) = ws.split();
    let mut rx = shared.tx.subscribe();
    let replay = shared.link.replay.as_ref().map(|r| r.file.clone());
    sink.send(WsMsg::text(json!({
        "type":"hello","bridge":"aracua-bridge","version":env!("CARGO_PKG_VERSION"),
        "mavlink": replay.as_ref().map(|f| format!("reprodução: {f}")).unwrap_or(mavlink_addr),
        "replay": replay.is_some(), "log_file": shared.link.log_file(),
    }).to_string())).await?;
    let pv = shared.payload.lock().unwrap().view(now_ms());
    sink.send(WsMsg::text(pv.to_string())).await?;
    let mv = shared.mission_view();
    if let Some(v) = mv {
        sink.send(WsMsg::text(v.to_string())).await?;
    }
    shared.clients.fetch_add(1, Ordering::SeqCst);
    let history: Vec<_> = shared.map_history.lock().unwrap().0.clone();
    for frame in history {
        sink.send(WsMsg::binary(frame.as_ref().clone())).await?;
    }
    let writer = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(Out::Text(t)) => {
                    if sink.send(WsMsg::text(t.as_str())).await.is_err() {
                        break;
                    }
                }
                Ok(Out::Binary(b)) => {
                    if sink.send(WsMsg::binary(b.as_ref().clone())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => tracing::warn!("{peer}: {n} mensagens descartadas (cliente lento)"),
                Err(_) => break,
            }
        }
    });
    while let Some(msg) = source.next().await {
        let text = match msg {
            Ok(WsMsg::Text(t)) => t,
            Ok(WsMsg::Close(_)) | Err(_) => break,
            _ => continue,
        };
        match serde_json::from_str::<commands::Command>(&text) {
            Ok(cmd) => {
                tracing::debug!("comando de {peer}: {cmd:?}");
                let s = shared.clone();
                tokio::spawn(async move {
                    if let Err(e) = commands::execute(&s, cmd).await {
                        s.emit(json!({"type":"error","message":e}));
                    }
                });
            }
            Err(e) => shared.emit(json!({"type":"error","message":format!("comando inválido: {e}")})),
        }
    }
    writer.abort();
    tracing::info!("interface desconectada: {peer}");
    if shared.clients.fetch_sub(1, Ordering::SeqCst) == 1 && shared.payload.lock().unwrap().abort("nenhuma interface conectada") {
        tracing::warn!("entrega: contagem abortada porque a última interface desconectou");
        shared.emit_payload();
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let args = Args::parse();
    if args.exit_with_parent {
        aracua_bridge::exit_when_stdin_closes();
    }
    let link = match &args.replay {
        Some(path) => {
            let l = link::Link::replay(path, args.replay_speed)?;
            let r = l.replay.as_ref().unwrap();
            tracing::info!("reproduzindo {} ({:.0} s) a {}x", path.display(), r.duration_s(), args.replay_speed);
            l
        }
        None => {
            let conn = mavlink::connect::<MavMessage>(&args.mavlink)?;
            tracing::info!("MAVLink em {}", args.mavlink);
            let dir = (!args.no_log).then(|| args.log_dir.clone());
            if let Some(d) = &dir {
                tracing::info!("voos gravados em {}", d.display());
            }
            link::Link::new(conn, dir)
        }
    };
    // Na rede, a ponte nunca fica aberta sem token.
    let local = args.ws.starts_with("127.") || args.ws.starts_with("localhost:") || args.ws.starts_with("[::1]");
    let token = match (args.token.clone().filter(|t| !t.is_empty()), local) {
        (Some(t), _) => Some(t),
        (None, true) => None,
        (None, false) => {
            let t = random_token();
            tracing::warn!("WebSocket aberto na rede sem --token: use ws://<IP desta máquina>:{}/?token={t}", args.ws.rsplit(':').next().unwrap_or("8765"));
            Some(t)
        }
    };
    let token = token.map(Arc::new);
    tracing::info!("entrega: configuração em {}", args.payload_file.display());
    let (tx, _) = broadcast::channel(512);
    let shared = Arc::new(Shared {
        link,
        state: Mutex::new(state::State::default()),
        mission: Mutex::new(mission::Uploader::default()),
        downloader: Mutex::new(mission::Downloader::default()),
        vehicle_mission: Mutex::new(None),
        payload: Mutex::new(payload::Payload::load(Some(args.payload_file.clone()))),
        tx,
        clients: AtomicUsize::new(0),
        map_history: Mutex::new((Vec::new(), 0)),
    });

    let s = shared.clone();
    std::thread::Builder::new().name("mavlink-rx".into()).spawn(move || receive_loop(s))?;
    tokio::spawn(periodic(shared.clone()));
    let (s, a) = (shared.clone(), args.map_udp.clone());
    tokio::spawn(async move {
        if let Err(e) = map_feed(s, a).await {
            tracing::error!("mapa LiDAR: {e}");
        }
    });

    let listener = TcpListener::bind(&args.ws).await?;
    tracing::info!("WebSocket em ws://{}", args.ws);
    loop {
        let (stream, _) = listener.accept().await?;
        let (s, m, t) = (shared.clone(), args.mavlink.clone(), token.clone());
        tokio::spawn(async move {
            if let Err(e) = client(s, stream, m, t).await {
                tracing::debug!("cliente: {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_na_url() {
        assert_eq!(request_token(Some("token=abc")), Some("abc".into()));
        assert_eq!(request_token(Some("x=1&token=abc&y=2")), Some("abc".into()));
        assert_eq!(request_token(Some("x=1")), None);
        assert_eq!(request_token(None), None);
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abc", "abd"));
        assert!(!same_token("abc", "abcd"));
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
