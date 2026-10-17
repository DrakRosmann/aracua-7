// Sem janela de console no Windows em modo release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK com o renderizador DMA-BUF quebra no Wayland com driver NVIDIA ("Error 71
    // (Protocol error) dispatching to Wayland display") e a janela nem abre. Sem ele, desenha
    // pelo caminho antigo, que funciona em qualquer placa. Quem quiser pode definir a variável.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Ainda não há outras threads lendo o ambiente.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    aracua_desktop_lib::run()
}
