# Aracuã-7

[![CI](https://github.com/DrakRosmann/aracua-7/actions/workflows/ci.yml/badge.svg)](https://github.com/DrakRosmann/aracua-7/actions/workflows/ci.yml)

Quadricóptero de mapeamento com LiDAR e entrega de carga: controladora de voo própria
(STM32H743 + ArduPilot), código de bordo em ROS 2 e estação de solo. Este repositório
reúne tudo:

| Pasta | O que é |
|---|---|
| [`gcs-web/`](gcs-web/), [`bridge/`](bridge/), [`ros2_ws/`](ros2_ws/) | software: interface, ponte MAVLink e nós de bordo (abaixo) |
| [`docs/`](docs/) | arquitetura, protocolo entre as partes e quadros binários de referência |
| [`hardware/hwdef/`](hardware/hwdef/Aracua7/) | definição da placa Aracuã-7 para o ArduPilot, parâmetros padrão e script Lua da entrega |
| [`hardware/kicad-import/`](hardware/kicad-import/) | importação das peças (LCSC/EasyEDA) para o projeto KiCad |
| [`hardware/guia-da-placa.pdf`](hardware/guia-da-placa.pdf) | guia de projeto da placa e lista de compras |

## Estação de solo

O software tem três partes:

| Pasta        | Linguagem          | Roda em               | Faz |
|--------------|--------------------|-----------------------|-----|
| `gcs-web/`   | TypeScript + React | navegador             | interface: mapa, instrumentos, planejamento, configuração, análise |
| `bridge/`    | Rust               | computador de solo    | fala MAVLink com o piloto automático e WebSocket com a interface |
| `ros2_ws/`   | C++ / ROS 2        | computador de bordo   | mapa de voxels do LiDAR, anticolisão, envio do mapa para o solo |

```
 navegador ──WebSocket 8765──▶ aracua-bridge ──MAVLink (rádio/UDP 14550)──▶ ArduCopter
                                     ▲                                          ▲
                                     │ UDP 14600 (mapa LiDAR)                   │ MAVLink (MAVROS)
                                     └──────────── ROS 2 (computador de bordo) ─┘
```

O contrato entre as partes está em [`docs/protocolo.md`](docs/protocolo.md).

## Sistema de entrega

Até 16 compartimentos (a placa Aracuã-7 tem 6 saídas de servo com chave de confirmação e 2 de solenoide).
Na tela de voo, o painel **Entrega** mostra o contador de lançamentos, o que está carregado e um botão
**Soltar** por compartimento, além de soltar os selecionados ou todos em salva.

1. **Armar entrega** (dois cliques) libera os botões.
2. **Soltar** começa a contagem regressiva (3 s por padrão). **Abortar** ou `Esc` cancela.
3. A ponte confere de novo as travas (motores armados, altura mínima, compartimento carregado) e manda
   `MAV_CMD_DO_SET_SERVO`. A chave do compartimento confirma que o pino saiu; o lançamento entra no
   contador com posição e altura e aparece no mapa.

Os compartimentos são configurados em **Configurar → Entrega**, a entrega por waypoint em **Planejar**
(selecione o waypoint e marque o compartimento) e o histórico fica em **Analisar → Lançamentos**.
A configuração e o contador ficam em `entrega.json`, ao lado da ponte (`--payload-file` muda o caminho).

## Começar sem hardware (5 minutos)

A ponte traz um veículo simulado (`fake-vehicle`) que fala MAVLink como um
ArduCopter simplificado e envia um mapa LiDAR sintético.

```bash
# Terminal 1 — ponte
cd bridge
cargo run --release --bin aracua-bridge

# Terminal 2 — veículo simulado
cd bridge
cargo run --release --bin fake-vehicle

# Terminal 3 — interface
cd gcs-web
npm install
npm run dev          # abra http://localhost:5173
```

No Windows, com Rust e Node.js instalados, dê dois cliques em `iniciar-teste.bat`: ele compila,
abre as três janelas e o navegador. No Linux ou macOS, `./iniciar-teste.sh` faz o mesmo num terminal só.

Na interface: **Decolar** → **Planejar** → **Varredura LiDAR** → **Gerar varredura**
→ **Enviar ao veículo** → **Iniciar missão**.

O veículo simulado serve para testar a interface. Para validar voo de verdade, use o SITL.

## Testar com o SITL do ArduPilot + ROS 2

Requisitos: ArduPilot SITL, ROS 2 (Humble ou Jazzy), `mavros` e `mavros_extras`.

```bash
# 1. SITL mandando MAVLink para a ponte (14550) e para o MAVROS (14555)
sim_vehicle.py -v ArduCopter --out udp:127.0.0.1:14550 --out udp:127.0.0.1:14555

# 2. Workspace ROS 2: MAVROS + LiDAR simulado + nós de bordo
cd ros2_ws
colcon build --symlink-install
source install/setup.bash
ros2 launch aracua_onboard sitl.launch.py

# 3. Ponte e interface, como acima (sem o fake-vehicle)
```

Para a anticolisão do ArduPilot usar os setores do LiDAR, configure `PRX1_TYPE = 2`
(MAVLink) e `AVOID_ENABLE = 7`.

## No drone de verdade

* **Solo:** `aracua-bridge --mavlink serial:/dev/ttyUSB0:57600` (rádio de telemetria)
  ou `--mavlink udpin:0.0.0.0:14550` (rádio IP / MAVLink router).
* **Bordo:** rode o driver do seu LiDAR publicando `sensor_msgs/PointCloud2` e depois
  `ros2 launch aracua_onboard onboard.launch.py ground_host:=<IP do solo> cloud_topic:=<tópico>`.
  Com um SLAM como o FAST-LIO, aponte `cloud_topic` para `/cloud_registered` e
  ligue `cloud_in_map_frame: true` em `config/onboard.yaml`.
* **Banda do mapa:** `map_link.max_kbps` limita o envio (mapa e setores de anticolisão juntos;
  os setores têm prioridade). Rádios 915 MHz aguentam ~50–150 kbit/s; links IP de 5,8 GHz aguentam
  bem mais. Cada datagrama tem no máximo `max_datagram_bytes` (1400), para não fragmentar.
* **Origem do mapa:** vem do `gp_origin` do MAVROS. Se ele não chegar em `origin_timeout_s`
  (o ArduPilot só envia `GPS_GLOBAL_ORIGIN` quando o EKF define a origem), o `map_link` estima a
  origem pelo GPS e pela posição local.
* **Vídeo:** a interface exibe MJPEG, HLS ou MP4. Um jeito prático é o
  [MediaMTX](https://github.com/bluenviron/mediamtx) recebendo RTSP da câmera e
  servindo HLS; cole a URL em **Configurar → Estação**.

## Testes

```bash
cd bridge && cargo test                         # modos, quadros do mapa, comandos, missão, entrega
cd ros2_ws && colcon build && colcon test       # núcleo C++ (gtest)
cd gcs-web && npm test && npm run build         # decodificação, geometria, tipos + build
```

Os três lados conferem os mesmos quadros binários de referência
([`docs/fixtures/`](docs/fixtures/)): se o formato mudar num deles, os testes dos outros quebram.
O [CI](.github/workflows/ci.yml) roda tudo a cada push, com o ROS 2 Jazzy num contêiner.

Sem ROS 2 instalado, dá para compilar e testar o código de bordo com Podman ou Docker:

```bash
podman run --rm -v "$PWD":/repo:Z -w /repo/ros2_ws ros:jazzy-ros-base bash -c \
  'apt-get update && apt-get install -y ros-jazzy-geographic-msgs && source /opt/ros/jazzy/setup.bash \
   && colcon build && colcon test && colcon test-result --verbose'
```

## Limitações conhecidas

* O WebSocket da ponte não tem autenticação: rode numa rede local ou VPN.
* Missões são de waypoints e entregas (mais decolagem e RTL automáticos); não há download da missão do veículo.
* A contagem regressiva roda na ponte. Entregas feitas pela missão não têm contagem: soltam ao chegar no ponto.
* Os modos e parâmetros usados são os do ArduCopter. PX4 exige outro mapeamento de modos.
* A camada LiDAR do mapa desenha até 60 mil obstáculos e 40 mil pontos de solo; para
  mapas maiores, troque a camada GeoJSON por deck.gl.
* O mapa de satélite padrão usa os tiles públicos da Esri, que exigem internet e atribuição.
  Para campo sem internet, sirva tiles locais e ajuste a URL em **Configurar → Estação**.
