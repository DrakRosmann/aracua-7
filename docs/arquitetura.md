# Arquitetura

## Por que três processos

* **Interface web (TypeScript/React):** roda em qualquer notebook ou tablet, sem instalação.
  Não fala MAVLink: recebe JSON pronto da ponte e manda comandos de alto nível.
* **Ponte (Rust):** único processo que conversa com o piloto automático. Mantém o estado
  do veículo, faz o protocolo de missão, repassa o mapa LiDAR. Sem coletor de lixo e com
  laço de recepção dedicado, a latência fica previsível.
* **Bordo (C++/ROS 2):** o LiDAR gera centenas de milhares de pontos por segundo; o mapa
  precisa ser feito no drone e só as células novas descem pelo rádio.

## Fluxo de dados

```
LiDAR ─PointCloud2─▶ voxel_mapper ─/aracua/voxels_delta─▶ map_link ─UDP AVX1─▶ ponte ─WS binário─▶ interface
      └────────────▶ obstacle_sectors ─LaserScan─▶ /mavros/obstacle/send ─▶ OBSTACLE_DISTANCE ─▶ ArduCopter
                                      └─/aracua/obstacle_scan─▶ map_link ─UDP AOB1─▶ ponte ─▶ interface
MAVROS /mavros/local_position/pose ──▶ voxel_mapper, obstacle_sectors, sim_lidar
MAVROS /mavros/global_position/gp_origin ──▶ map_link (origem geográfica do mapa)
```

A anticolisão acontece no piloto automático (via `OBSTACLE_DISTANCE`), não na
estação: se o rádio cair, o drone continua desviando.

## Nós ROS 2 (`aracua_onboard`)

| Nó                 | Entra                                  | Sai |
|--------------------|----------------------------------------|-----|
| `voxel_mapper`     | nuvem do LiDAR + pose                  | `/aracua/voxels_delta`, `/aracua/map` (RViz), serviço `~/reset` |
| `obstacle_sectors` | nuvem do LiDAR                         | `/mavros/obstacle/send`, `/aracua/obstacle_scan`, `/aracua/nearest_obstacle` |
| `map_link`         | deltas, setores, origem                | UDP para a ponte, com limite de banda |
| `sim_lidar`        | pose do MAVROS                         | `/lidar/points` sintético (só SITL) |

A lógica fica em cabeçalhos sem dependência de ROS (`include/aracua_onboard/`), testados
com gtest. Os nós são só a cola com o ROS.

## Ponte (`bridge/`)

* `state.rs` — monta a telemetria a partir das mensagens MAVLink.
* `commands.rs` — traduz os comandos JSON para MAVLink.
* `mission.rs` — envio de missão com reenvio e timeout; entregas viram itens DO_SET_SERVO + LOITER_TIME.
* `payload.rs` — sistema de entrega: compartimentos, travas de segurança, contagem regressiva,
  contador e histórico (gravados em `entrega.json`), confirmação pelas chaves e detecção pelo `SERVO_OUTPUT_RAW`.
* `mapframe.rs` — formato dos quadros binários (mesmo layout do C++, conferido byte a byte).
* `bin/fake_vehicle.rs` — veículo simulado para testar sem SITL.
* Os quadros do mapa são conferidos contra `docs/fixtures/` nos testes.

## Interface (`gcs-web/`)

* `lib/store.ts` — estado central, conexão WebSocket com reconexão, log, parâmetros, plano, mapa.
  Componentes assinam "canais" (`telemetry`, `mission`, `map`…) para só re-renderizar o necessário.
* `components/MapView.tsx` — MapLibre: satélite, veículo, trilha, missão, geocerca, voxels.
* `components/Instruments.tsx` — mostradores em canvas, redesenhados a cada quadro.
* `components/Delivery.tsx` — painel de entrega na tela de voo, contagem regressiva com aborto (Esc),
  configuração dos compartimentos, histórico de lançamentos e escolha de entrega por waypoint.
* `views/` — as quatro abas: Voo, Planejar, Configurar, Analisar.
