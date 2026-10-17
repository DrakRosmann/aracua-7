//! Aplicativo desktop da estação Aracuã-7.
//!
//! A janela mostra a mesma interface do `gcs-web/`. Este processo cuida do resto:
//! sobe a ponte (`aracua-bridge`) e, no modo simulador, o veículo simulado
//! (`fake-vehicle`), ambos empacotados junto com o app. Trocar de conexão é
//! parar e subir a ponte de novo — as portas são liberadas pelo sistema e um
//! travamento da ponte não derruba a janela.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

/// Portas padrão; mudam com ARACUA_WS_PORT, ARACUA_SIM_PORT e ARACUA_MAP_PORT
/// (para rodar duas cópias do app ao mesmo tempo, por exemplo).
const DEFAULT_WS_PORT: u16 = 8765;
const DEFAULT_SIM_PORT: u16 = 14550;
const DEFAULT_MAP_PORT: u16 = 14600;

fn port(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// WebSocket da ponte; só a própria máquina acessa.
fn bridge_ws() -> String {
    format!("127.0.0.1:{}", port("ARACUA_WS_PORT", DEFAULT_WS_PORT))
}
/// Senha do WebSocket desta execução do app: só a janela do app a conhece, então
/// outro programa ou página aberta no navegador não comanda o veículo pela ponte.
fn session_token() -> String {
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

/// Linhas de log guardadas para mostrar na tela de conexão.
const LOG_LINES: usize = 400;

/// Como chegar ao veículo. Vem da tela "Conectar" da interface.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkConfig {
    /// Veículo simulado embutido (cinemático), com mapa LiDAR sintético.
    Simulator {
        #[serde(default)]
        lat: Option<f64>,
        #[serde(default)]
        lon: Option<f64>,
        /// copter, heli, plane ou vtol (padrão: copter).
        #[serde(default)]
        vehicle: Option<String>,
        /// electric, combustion, jet ou hybrid (padrão: electric).
        #[serde(default)]
        propulsion: Option<String>,
    },
    /// Rádio de telemetria ou cabo USB.
    Serial { port: String, baud: u32 },
    /// Escuta MAVLink por UDP (rádio IP, MAVLink router, SITL com --out).
    Udp { listen: String },
    /// Conecta por TCP (ex.: SITL em 127.0.0.1:5760).
    Tcp { address: String },
    /// Reproduz um voo gravado (.tlog); nenhum comando chega a veículo algum.
    Replay { file: String },
}

impl LinkConfig {
    /// Endereço no formato do `--mavlink` da ponte.
    pub fn mavlink_url(&self) -> Result<String, String> {
        let clean = |s: &str, what: &str| {
            let s = s.trim();
            if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
                Err(format!("{what} inválido: {s:?}"))
            } else {
                Ok(s.to_string())
            }
        };
        Ok(match self {
            LinkConfig::Simulator { .. } => format!("udpin:127.0.0.1:{}", port("ARACUA_SIM_PORT", DEFAULT_SIM_PORT)),
            LinkConfig::Serial { port, baud } => {
                if !(1200..=3_000_000).contains(baud) {
                    return Err(format!("velocidade inválida: {baud}"));
                }
                format!("serial:{}:{baud}", clean(port, "porta serial")?)
            }
            LinkConfig::Udp { listen } => format!("udpin:{}", host_port(&clean(listen, "endereço UDP")?)?),
            LinkConfig::Tcp { address } => format!("tcpout:{}", host_port(&clean(address, "endereço TCP")?)?),
            LinkConfig::Replay { file } => format!("reprodução: {file}"),
        })
    }
}

/// Tipos de veículo que o simulador conhece.
fn sim_vehicle(v: &str) -> Result<&'static str, String> {
    ["copter", "heli", "plane", "vtol"]
        .into_iter()
        .find(|k| *k == v)
        .ok_or_else(|| format!("tipo de veículo do simulador inválido: {v:?}"))
}

/// Motores que o simulador conhece.
fn sim_propulsion(p: &str) -> Result<&'static str, String> {
    ["electric", "combustion", "jet", "hybrid"]
        .into_iter()
        .find(|k| *k == p)
        .ok_or_else(|| format!("motor do simulador inválido: {p:?}"))
}

/// Aceita "host:porta" ou só "porta" (escuta em todas as interfaces).
fn host_port(s: &str) -> Result<String, String> {
    let s = s.trim_start_matches("udp://").trim_start_matches("tcp://");
    if let Ok(p) = s.parse::<u16>() {
        return Ok(format!("0.0.0.0:{p}"));
    }
    let (host, port) = s.rsplit_once(':').ok_or_else(|| format!("use host:porta, por exemplo 0.0.0.0:14550 (recebido {s:?})"))?;
    port.parse::<u16>().map_err(|_| format!("porta inválida em {s:?}"))?;
    if host.is_empty() {
        return Err(format!("host vazio em {s:?}"));
    }
    Ok(format!("{host}:{port}"))
}

#[derive(Serialize, Clone)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize, Clone)]
pub struct LinkStatus {
    pub running: bool,
    pub config: Option<LinkConfig>,
    /// Código de saída se a ponte terminou sozinha.
    pub exit_code: Option<i32>,
    pub bridge_url: String,
    pub log: Vec<String>,
}

struct Running {
    config: LinkConfig,
    bridge: Child,
    sim: Option<Child>,
    /// Entradas dos filhos: enquanto abertas, eles vivem (`--exit-with-parent`).
    /// Se este processo morrer de qualquer jeito, o sistema as fecha e os filhos saem.
    _stdin: Vec<ChildStdin>,
}

pub struct Supervisor {
    running: Mutex<Option<Running>>,
    exit_code: Mutex<Option<i32>>,
    log: Arc<Mutex<VecDeque<String>>>,
    token: String,
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor { running: Mutex::default(), exit_code: Mutex::default(), log: Arc::default(), token: session_token() }
    }
}

/// Um voo gravado pela ponte, para a lista "Reproduzir voo".
#[derive(Serialize, Clone)]
pub struct FlightLog {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    /// Segundos desde 1970.
    pub modified: u64,
}

impl Supervisor {
    fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
        let mut l = log.lock().unwrap();
        l.push_back(line);
        while l.len() > LOG_LINES {
            l.pop_front();
        }
    }

    fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            if let Some(mut s) = r.sim.take() {
                let _ = s.kill();
                let _ = s.wait();
            }
            let _ = r.bridge.kill();
            let _ = r.bridge.wait();
            Self::push_log(&self.log, "— conexão encerrada".into());
        }
    }

    fn status(&self) -> LinkStatus {
        let mut guard = self.running.lock().unwrap();
        // A ponte morreu sozinha (porta ocupada, rádio desconectado…)?
        if let Some(r) = guard.as_mut() {
            if let Ok(Some(st)) = r.bridge.try_wait() {
                *self.exit_code.lock().unwrap() = st.code();
                if let Some(mut s) = r.sim.take() {
                    let _ = s.kill();
                    let _ = s.wait();
                }
                *guard = None;
            }
        }
        LinkStatus {
            running: guard.is_some(),
            config: guard.as_ref().map(|r| r.config.clone()),
            exit_code: *self.exit_code.lock().unwrap(),
            bridge_url: format!("ws://{}/?token={}", bridge_ws(), self.token),
            log: self.log.lock().unwrap().iter().cloned().collect(),
        }
    }
}

/// Caminho de um executável empacotado ao lado do app (externalBin do Tauri).
fn sidecar(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("pasta do executável desconhecida")?;
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let p = dir.join(&file);
    if p.exists() {
        Ok(p)
    } else {
        Err(format!("{file} não encontrado em {}", dir.display()))
    }
}

/// Lê stdout/stderr de um processo para o log, sem as cores do terminal.
fn capture(log: &Arc<Mutex<VecDeque<String>>>, prefix: &'static str, stream: impl Read + Send + 'static) {
    let log = log.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            Supervisor::push_log(&log, format!("{prefix}{}", strip_ansi(&line)));
        }
    });
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                for d in it.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn spawn(path: &PathBuf, args: &[String], envs: &[(&str, &str)]) -> std::io::Result<Child> {
    let mut cmd = Command::new(path);
    cmd.args(args).envs(envs.iter().copied()).arg("--exit-with-parent").env("NO_COLOR", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
}

#[tauri::command]
fn serial_ports() -> Vec<PortInfo> {
    let mut ports: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    let name = [u.manufacturer, u.product].into_iter().flatten().collect::<Vec<_>>().join(" ");
                    if name.is_empty() { format!("USB {:04x}:{:04x}", u.vid, u.pid) } else { name }
                }
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::Unknown => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect();
    // Portas USB (rádios, controladoras) primeiro.
    ports.sort_by_key(|p| (p.description.is_empty(), p.name.clone()));
    ports
}

fn logs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("logs"))
}

#[tauri::command]
fn list_logs(app: tauri::AppHandle) -> Result<Vec<FlightLog>, String> {
    let dir = logs_dir(&app)?;
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out: Vec<FlightLog> = rd
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "tlog"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some(FlightLog {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                bytes: m.len(),
                modified: m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs(),
            })
        })
        // Arquivos de 0 a poucos bytes: conexão sem veículo.
        .filter(|l| l.bytes > 1024)
        .collect();
    out.sort_by_key(|l| std::cmp::Reverse(l.modified));
    Ok(out)
}

#[tauri::command]
fn start_link(app: tauri::AppHandle, sup: State<'_, Supervisor>, config: LinkConfig) -> Result<LinkStatus, String> {
    let url = config.mavlink_url()?;
    sup.stop();
    *sup.exit_code.lock().unwrap() = None;

    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| format!("não foi possível criar {}: {e}", data.display()))?;
    let payload = data.join("entrega.json");
    let maintenance = data.join("manutencao.json");

    Supervisor::push_log(&sup.log, format!("— conectando: {url}"));
    // O token vai por variável de ambiente (ARACUA_TOKEN): não aparece na lista de processos.
    let mut bridge_args: Vec<String> = vec![
        "--ws".into(),
        bridge_ws(),
        "--map-udp".into(),
        format!("0.0.0.0:{}", port("ARACUA_MAP_PORT", DEFAULT_MAP_PORT)),
        "--payload-file".into(),
        payload.to_string_lossy().into_owned(),
        "--maintenance-file".into(),
        maintenance.to_string_lossy().into_owned(),
    ];
    if let LinkConfig::Replay { file } = &config {
        let f = PathBuf::from(file);
        if !f.is_file() {
            return Err(format!("arquivo não encontrado: {file}"));
        }
        bridge_args.extend(["--replay".into(), file.clone()]);
    } else {
        bridge_args.extend(["--mavlink".into(), url.clone(), "--log-dir".into(), logs_dir(&app)?.to_string_lossy().into_owned()]);
    }
    let mut bridge = spawn(&sidecar("aracua-bridge")?, &bridge_args, &[("ARACUA_TOKEN", &sup.token)]).map_err(|e| format!("falha ao iniciar a ponte: {e}"))?;
    capture(&sup.log, "", bridge.stdout.take().unwrap());
    capture(&sup.log, "", bridge.stderr.take().unwrap());
    let mut stdin = vec![bridge.stdin.take().unwrap()];

    let sim = if let LinkConfig::Simulator { lat, lon, vehicle, propulsion } = &config {
        let mut args = vec![
            "--mavlink".into(),
            format!("udpout:127.0.0.1:{}", port("ARACUA_SIM_PORT", DEFAULT_SIM_PORT)),
            "--map".into(),
            format!("127.0.0.1:{}", port("ARACUA_MAP_PORT", DEFAULT_MAP_PORT)),
        ];
        if let Some(v) = vehicle {
            args.extend(["--vehicle".into(), sim_vehicle(v)?.into()]);
        }
        if let Some(p) = propulsion {
            args.extend(["--propulsion".into(), sim_propulsion(p)?.into()]);
        }
        if let (Some(lat), Some(lon)) = (lat, lon) {
            args.extend(["--lat".into(), lat.to_string(), "--lon".into(), lon.to_string()]);
        }
        match sidecar("fake-vehicle").and_then(|p| spawn(&p, &args, &[]).map_err(|e| e.to_string())) {
            Ok(mut c) => {
                capture(&sup.log, "[simulador] ", c.stdout.take().unwrap());
                capture(&sup.log, "[simulador] ", c.stderr.take().unwrap());
                stdin.push(c.stdin.take().unwrap());
                Some(c)
            }
            Err(e) => {
                let _ = bridge.kill();
                let _ = bridge.wait();
                return Err(format!("falha ao iniciar o simulador: {e}"));
            }
        }
    } else {
        None
    };

    *sup.running.lock().unwrap() = Some(Running { config, bridge, sim, _stdin: stdin });
    // Dá tempo de a ponte abrir as portas; se morrer logo, a tela mostra o motivo.
    std::thread::sleep(Duration::from_millis(500));
    let st = sup.status();
    if !st.running {
        let tail: Vec<_> = st.log.iter().rev().take(4).rev().cloned().collect();
        return Err(format!("a ponte encerrou ao iniciar:\n{}", tail.join("\n")));
    }
    Ok(st)
}

#[tauri::command]
fn stop_link(sup: State<'_, Supervisor>) -> LinkStatus {
    sup.stop();
    sup.status()
}

#[tauri::command]
fn link_status(sup: State<'_, Supervisor>) -> LinkStatus {
    sup.status()
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Supervisor::default())
        .invoke_handler(tauri::generate_handler![serial_ports, start_link, stop_link, link_status, list_logs])
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o aplicativo");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Supervisor>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_da_ponte() {
        let sim = LinkConfig::Simulator { lat: None, lon: None, vehicle: None, propulsion: None };
        assert_eq!(sim.mavlink_url().unwrap(), "udpin:127.0.0.1:14550");
        let s = LinkConfig::Serial { port: "/dev/ttyUSB0".into(), baud: 57600 };
        assert_eq!(s.mavlink_url().unwrap(), "serial:/dev/ttyUSB0:57600");
        let s = LinkConfig::Serial { port: "COM3".into(), baud: 115200 };
        assert_eq!(s.mavlink_url().unwrap(), "serial:COM3:115200");
        assert_eq!(LinkConfig::Udp { listen: "14550".into() }.mavlink_url().unwrap(), "udpin:0.0.0.0:14550");
        assert_eq!(LinkConfig::Udp { listen: "udp://0.0.0.0:14551".into() }.mavlink_url().unwrap(), "udpin:0.0.0.0:14551");
        assert_eq!(LinkConfig::Tcp { address: "127.0.0.1:5760".into() }.mavlink_url().unwrap(), "tcpout:127.0.0.1:5760");
    }

    #[test]
    fn recusa_enderecos_ruins() {
        assert!(LinkConfig::Serial { port: "".into(), baud: 57600 }.mavlink_url().is_err());
        assert!(LinkConfig::Serial { port: "/dev/tty USB0".into(), baud: 57600 }.mavlink_url().is_err());
        assert!(LinkConfig::Serial { port: "/dev/ttyUSB0".into(), baud: 7 }.mavlink_url().is_err());
        assert!(LinkConfig::Udp { listen: "0.0.0.0:99999".into() }.mavlink_url().is_err());
        assert!(LinkConfig::Tcp { address: "sem-porta".into() }.mavlink_url().is_err());
        assert!(LinkConfig::Tcp { address: ":5760".into() }.mavlink_url().is_err());
    }

    #[test]
    fn json_da_interface() {
        let c: LinkConfig = serde_json::from_str(r#"{"kind":"serial","port":"/dev/ttyACM0","baud":921600}"#).unwrap();
        assert_eq!(c, LinkConfig::Serial { port: "/dev/ttyACM0".into(), baud: 921600 });
        let c: LinkConfig = serde_json::from_str(r#"{"kind":"simulator"}"#).unwrap();
        assert_eq!(c, LinkConfig::Simulator { lat: None, lon: None, vehicle: None, propulsion: None });
        let c: LinkConfig = serde_json::from_str(r#"{"kind":"simulator","vehicle":"plane","propulsion":"jet"}"#).unwrap();
        assert_eq!(c, LinkConfig::Simulator { lat: None, lon: None, vehicle: Some("plane".into()), propulsion: Some("jet".into()) });
    }

    #[test]
    fn tipos_do_simulador() {
        assert_eq!(sim_vehicle("vtol"), Ok("vtol"));
        assert!(sim_vehicle("rover").is_err());
        assert!(sim_vehicle("plane --mavlink x").is_err());
        assert_eq!(sim_propulsion("hybrid"), Ok("hybrid"));
        assert!(sim_propulsion("nuclear").is_err());
    }

    #[test]
    fn token_por_execucao() {
        let a = Supervisor::default();
        let b = Supervisor::default();
        assert_eq!(a.token.len(), 32);
        assert_ne!(a.token, b.token);
        assert!(a.status().bridge_url.ends_with(&format!("/?token={}", a.token)));
        let c: LinkConfig = serde_json::from_str(r#"{"kind":"replay","file":"/tmp/x.tlog"}"#).unwrap();
        assert_eq!(c, LinkConfig::Replay { file: "/tmp/x.tlog".into() });
    }

    #[test]
    fn tira_cores() {
        assert_eq!(strip_ansi("\u{1b}[32m INFO\u{1b}[0m ok"), " INFO ok");
    }
}
