# App desktop

Empacota a interface (`gcs-web/`) numa janela própria com [Tauri 2](https://tauri.app) e leva
junto a ponte (`aracua-bridge`) e o veículo simulado (`fake-vehicle`) como executáveis auxiliares.

```
 janela (WebView) ── WebSocket 127.0.0.1:8765 ──▶ aracua-bridge ──MAVLink──▶ drone / SITL / fake-vehicle
        │                                              ▲
        └── comandos Tauri (start_link, serial_ports…) ─┘  o app inicia e encerra a ponte
```

* A tela **Conectar** chama `start_link` com o tipo de conexão; o app sobe a ponte com o
  `--mavlink` certo (e o simulador, se for o caso). Trocar de conexão reinicia a ponte, o que libera
  as portas do jeito mais simples.
* A ponte e o simulador rodam com `--exit-with-parent`: se o app fechar de qualquer jeito, até por
  `kill -9`, eles saem sozinhos.
* Portas: `ARACUA_WS_PORT` (8765), `ARACUA_SIM_PORT` (14550) e `ARACUA_MAP_PORT` (14600) mudam as
  portas da ponte e do simulador, para rodar duas cópias ao mesmo tempo.
* O WebSocket escuta só em `127.0.0.1`. O mapa LiDAR do computador de bordo continua chegando por
  UDP na porta 14600 (todas as interfaces), como na ponte avulsa.
* A configuração da entrega e o contador ficam na pasta de dados do app
  (`~/.local/share/io.github.drakrosmann.aracua7/` no Linux, `%APPDATA%\io.github.drakrosmann.aracua7\` no Windows).

## Compilar

Pré-requisitos: Rust, Node.js 22 e as [dependências do Tauri](https://tauri.app/start/prerequisites/)
(no Linux: WebKitGTK 4.1, librsvg, libudev).

```bash
(cd ../gcs-web && npm ci)
npm ci
npm run dev      # janela de desenvolvimento, com recarga da interface
npm run build    # instaladores em src-tauri/target/release/bundle/
```

`scripts/sidecars.mjs` compila a ponte e o simulador e os coloca em `src-tauri/binaries/` com o
nome que o Tauri espera. Os instaladores oficiais saem do workflow
[`release.yml`](../.github/workflows/release.yml) a cada tag `v*`.

O ícone vem de `icone.svg`; para gerar de novo: `rsvg-convert -w 1024 icone.svg -o icone.png && npx tauri icon icone.png -o src-tauri/icons`.
