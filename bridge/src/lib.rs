//! Núcleo compartilhado entre a ponte e o veículo simulado.

pub mod mapframe;
pub mod modes;

pub use mavlink::dialects::ardupilotmega as apm;

/// Identidade da estação de solo na rede MAVLink.
pub const GCS_SYSTEM_ID: u8 = 255;
pub const GCS_COMPONENT_ID: u8 = 190;

/// Milissegundos desde a época Unix.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Encerra o processo quando a entrada padrão fecha. O app desktop inicia a ponte e o
/// simulador com a entrada ligada a ele: se o app morrer de qualquer jeito (até por
/// `kill -9`), o sistema fecha o cano e os filhos saem, liberando as portas.
pub fn exit_when_stdin_closes() {
    std::thread::Builder::new()
        .name("stdin-watch".into())
        .spawn(|| {
            let mut buf = [0u8; 64];
            loop {
                match std::io::Read::read(&mut std::io::stdin(), &mut buf) {
                    Ok(0) | Err(_) => {
                        tracing::info!("processo pai encerrou; saindo");
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                }
            }
        })
        .expect("thread stdin-watch");
}

/// Converte um `CharArray` do MAVLink em `String`, parando no primeiro zero.
pub fn char_array_to_string<const N: usize>(c: &mavlink::types::CharArray<N>) -> String {
    let bytes: &[u8] = &c[..];
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}
