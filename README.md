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

## Instalar

Baixe o instalador da [última versão](https://github.com/DrakRosmann/aracua-7/releases/latest):
`.exe`/`.msi` no Windows, `.AppImage`/`.deb`/`.rpm` no Linux e `.dmg` no macOS.

O app junta a interface, a ponte MAVLink e o simulador. Ao abrir, a tela **Conectar** pergunta
como chegar ao drone:

* **Simulador** — veículo virtual com mapa LiDAR sintético, para treinar e testar sem hardware:
  multirrotor, helicóptero, avião ou VTOL, com motor elétrico, a combustão, turbina ou híbrido;
* **Rádio de telemetria** — escolha a porta serial (rádio SiK a 57600 ou USB da controladora);
* **Rede (UDP)** — rádio IP, MAVLink router ou SITL enviando para a máquina;
* **TCP / SITL** — por exemplo `127.0.0.1:5760`;
* **Reproduzir voo** — revê um voo gravado (toda conexão é gravada em `.tlog`), com pausa,
  velocidade de 1× a 16× e barra para pular; nenhum comando sai para veículo algum.

A escolha fica salva e o app reconecta sozinho na próxima vez; para trocar, use o menu
**Aracuã-7 ▾ → Trocar conexão**. Detalhes e como compilar o app em [`desktop/`](desktop/).

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

O que mais a estação faz:

* **Missão no veículo:** ao conectar, a ponte lê a missão gravada no piloto automático e a mostra no
  mapa (tracejada em Planejar, se for diferente do rascunho); **Ler do veículo** relê e
  **Editar a missão do veículo** a copia para o plano.
* **Pré-voo na ponte:** antes de decolar ou iniciar missão no chão, a ponte exige conexão, GPS 3D com
  6+ satélites, bateria ≥ 25 % e home definido. Se algo falhar, a interface mostra o motivo e oferece
  "fazer mesmo assim" (o ArduPilot continua fazendo as verificações dele).
* **Gravação:** todo MAVLink recebido vai para um `.tlog` (o mesmo formato do Mission Planner e do
  QGroundControl) em `--log-dir` (padrão `logs/`; no app, na pasta de dados do app). `--no-log` desliga.
* **Mapa offline:** os tiles vistos com internet ficam guardados no navegador; em
  **Configurar → Estação → Mapa offline** dá para baixar a área enquadrada (até 4000 tiles por vez).
  Respeite os termos do servidor de tiles.
* **Calibração guiada:** acelerômetro (6 posições ou só nivelar), bússola com progresso, giroscópio e
  rádio (captura de extremos e gravação de `RCn_MIN/MAX/TRIM`).
* **Geocerca em polígono:** em Planejar → Geocerca, desenhe no mapa áreas permitidas (verde) e
  proibidas (vermelho) e envie ao veículo. A estação avisa se algum waypoint ou o home viola a cerca, e
  a ponte liga o bit de polígono em `FENCE_TYPE` quando precisa. Ao conectar, a cerca do veículo é lida.
* **Manutenção:** a ponte conta horas de voo, voos e ciclos da bateria em uso (do armar ao desarmar,
  se ficou no ar mais de 5 s) e guarda em `manutencao.json` (`--maintenance-file`). Em
  **Configurar → Manutenção** ficam as tarefas periódicas (por horas ou voos), as baterias, as anotações
  e o histórico de voos.
* **Painel do motor:** o botão **Motor** da tela de voo abre um painel no estilo EMS de avião, com
  mostradores e barras em faixas verde/amarela/vermelha. Elétrico: rotação e temperatura de cada ESC,
  tensão, corrente e temperatura da bateria e a tensão de cada célula. Combustão: RPM, CHT e EGT por
  cilindro, água, óleo e combustível (EFI). Turbina: N1, EGT, fluxo, bomba e estado da partida. Com um
  gerador a bordo (híbrido), mostra rotação, potência, carga da bateria e alarmes. Os limites ficam em
  **Configurar → Motor**; com o veículo armado, o que sai da faixa vai para o log (vermelho também na tela).
  Fontes e nomes dos sensores extras em [`docs/protocolo.md`](docs/protocolo.md#motor-e-energia-telemetrypropulsion).
* **Controle de videogame:** pilote com um controle de Xbox, 8BitDo, PlayStation ou similar (USB ou
  Bluetooth), no navegador ou no app. Sticks em modo 2 ou 1, com zona morta e expo; acelerador centrado
  (multirrotor segura a altitude), incremental (avião) ou pelos gatilhos. Botões configuráveis: armar
  segurando Start 1,5 s, RTL, pousar, pausar, foto, gimbal e três modos de voo. Os sticks só comandam armado
  num modo manual; sem foco na janela a estação manda sticks neutros, e se o controle desconectar ela avisa,
  manda neutro por 1 s e para. Erros vibram o controle. Ajustes e teste ao vivo em **Configurar → Controle**
  (com **Detectar** para controles fora do layout padrão, como o 8BitDo em modo D-input).
* **Piloto automático estilo avião:** o botão **A/P** da tela de voo abre um painel de modos como o de um
  avião (MCP), com o anunciador de modos (FMA) em cima: **HDG** (rumo selecionado), **NAV** (missão), **ALT**
  (segura a altitude), **V/S** (sobe ou desce até a altitude selecionada no ritmo escolhido e nivela) e **SPD**
  (velocidade). Os valores aparecem em ciano na bússola e na fita de altitude. Se o modo mudar por fora
  (rádio, failsafe), ele desliga com alarme sonoro e "AP OFF" piscando. No avião usa os comandos
  `GUIDED_CHANGE_*` do ArduPlane 4.5+; no multirrotor, a ponte manda velocidade e rumo em GUIDED. Detalhes em
  [`docs/protocolo.md`](docs/protocolo.md#piloto-automático).
* **Mapa 3D:** o botão **3D** da tela de voo inclina o mapa e mostra os obstáculos do LiDAR como blocos;
  gire com o botão direito do mouse ou com dois dedos.
* **Tablet:** em telas de toque os botões e campos ficam maiores, e entre 760 e 1180 px os painéis e
  mostradores encolhem para sobrar mapa.
* **Idioma e tema:** português ou inglês, tema escuro, claro ou o do sistema
  (**Configurar → Estação → Aparência**). As mensagens da ponte e do ArduPilot aparecem como chegam.

### Acesso pela rede

A ponte escuta só em `127.0.0.1` por padrão. Para abrir a interface de outro computador, use
`--ws 0.0.0.0:8765`: sem `--token` (ou `ARACUA_TOKEN`), a ponte gera uma senha e mostra no log a URL
`ws://<ip>:8765/?token=…`; quem conectar sem ela é recusado. Cole a URL com o token em
**Configurar → Estação → Endereço da ponte**. O app desktop gera um token novo a cada execução, para que
outro programa ou página aberta no navegador não comande o veículo pela ponte local. O token não é
criptografia: fora de rede confiável, use VPN.

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

`fake-vehicle --vehicle copter|heli|plane|vtol` escolhe o tipo. O multirrotor e o helicóptero
pairam (modos do ArduCopter). O avião decola correndo no modo TAKEOFF, precisa de velocidade para
voar, faz curvas inclinado e circula em LOITER e RTL (modos do ArduPlane). O VTOL decola na vertical,
voa como avião e paira nos modos Q (QHOVER, QLOITER, QLAND, QRTL).

`--propulsion electric|combustion|jet|hybrid` escolhe o motor: elétrico (ESCs e bateria 6S com células),
combustão (EFI com RPM, CHT/EGT de dois cilindros e tanque), turbina (N1, EGT e sequência de partida ao
armar) ou híbrido (elétrico com gerador que aquece 8 s e depois carrega a bateria). Só alimenta o painel do
motor: não muda a física do voo.

## Tipos de veículo

A ponte lê o tipo no HEARTBEAT (`MAV_TYPE`) e usa a tabela de modos do firmware certo: o mesmo número
de modo é LOITER no ArduCopter e FBWA no ArduPlane. A interface adapta o menu de modos, os botões
(no avião, "Pausar" vira "Circular" e não há "Pousar aqui" nem "Freio"), o comando Decolar (modo
TAKEOFF com `TKOFF_ALT` no avião) e o desenho no mapa.

| Classe | `MAV_TYPE` | Firmware |
|---|---|---|
| Multirrotor | QUADROTOR, HEXAROTOR, OCTOROTOR… | ArduCopter |
| Helicóptero | HELICOPTER | ArduCopter (TradHeli) |
| Avião | FIXED_WING | ArduPlane |
| VTOL | VTOL_* | ArduPlane (QuadPlane) |
| Terrestre | GROUND_ROVER, SURFACE_BOAT | ArduRover (modos e mapa; sem simulador ainda) |

**Configurar** mostra os parâmetros do firmware certo (velocidades e raios do ArduPlane, `Q_*` do VTOL,
rotor do TradHeli) e marca "indisponível neste firmware" o que o veículo não responde.

Na missão, avião e VTOL podem **terminar pousando** (padrão): a ponte acrescenta `DO_LAND_START`, dois
pontos de aproximação (500 m/40 m e 250 m/20 m antes do home, no rumo escolhido) e `NAV_LAND`; no VTOL,
`NAV_VTOL_TAKEOFF`/`NAV_VTOL_LAND`. Para que um RTL também pouse pela sequência, a ponte liga
`RTL_AUTOLAND = 1` ao enviar (o ArduPlane 4.6+ recusa armar com `DO_LAND_START` e `RTL_AUTOLAND = 0`).
A **entrega em voo** do avião não para sobre o alvo: a ponte põe o ponto de soltura antes dele, a
`v·√(2h/g)·0,85` (velocidade de cruzeiro `AIRSPEED_CRUISE`, altura h), com raio de 2 m. É balística
simples, sem vento: confira no campo.

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
cd gcs-web && npm test && npm run build         # decodificação, geometria, tiles, traduções + build
```

De ponta a ponta (Node 22, depois de `cargo build --bins` em `bridge/`):

```bash
node tests/simulador.mjs          # ponte + fake-vehicle: token, missão e download, entrega em voo do
                                  # avião, pouso, VTOL, gravação e reprodução, calibrações, geocerca,
                                  # manutenção, rádio, piloto automático, motor (elétrico, combustão,
                                  # turbina, híbrido)
tests/baixar-sitl.sh              # baixa o SITL oficial (ArduCopter e ArduPlane estáveis) em tests/.sitl
node tests/sitl.mjs               # ponte + SITL: missão com entrega, download, RTL e pouso (Copter);
                                  # TAKEOFF, missão e pouso com DO_LAND_START (Plane)
```

`ONLY=avião node tests/simulador.mjs` roda só os cenários com "avião" no nome. Cada cenário usa portas
próprias (28700+ e 29700+), sem esbarrar num app aberto.

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

* O token do WebSocket é uma senha simples, sem criptografia (`ws://`, não `wss://`): na rede, use VPN.
* Missões são de waypoints e entregas (mais decolagem, RTL e pouso automáticos). Ao ler do veículo,
  itens que a estação não conhece (ex.: `DO_CHANGE_SPEED`) são contados e não mostrados; editar e
  reenviar uma missão assim descarta esses itens.
* A contagem regressiva roda na ponte. Entregas feitas pela missão não têm contagem: soltam ao chegar no ponto.
* Só ArduPilot. PX4 exige outro mapeamento de modos e parâmetros.
* A interface está em português e inglês; as mensagens da ponte (erros, pré-voo) ficam em português.
* O ponto de soltura do avião ignora vento e arrasto da carga.
* A gravação guarda só o que chega do veículo (não o mapa LiDAR, que vem por outro canal); na
  reprodução o mapa LiDAR fica vazio.
* A camada LiDAR do mapa desenha até 60 mil obstáculos e 40 mil pontos de solo; para
  mapas maiores, troque a camada GeoJSON por deck.gl.
* O mapa de satélite padrão usa os tiles públicos da Esri, que exigem internet e atribuição.
  Para campo sem internet, sirva tiles locais e ajuste a URL em **Configurar → Estação**.
