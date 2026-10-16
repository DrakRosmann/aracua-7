# Protocolo entre ponte e interface

A ponte (`bridge/`) fala MAVLink com o piloto automático e expõe um WebSocket
para a interface (`gcs-web/`). Padrão: `ws://127.0.0.1:8765`.

**Autenticação:** com `--token` (ou `ARACUA_TOKEN`), o handshake exige `?token=<senha>` na URL
(`ws://host:8765/?token=…`); sem ele a conexão é recusada com HTTP 401. Escutando fora de
`127.0.0.1` sem token, a ponte gera um aleatório e o mostra no log.

Mensagens de texto são JSON. Mensagens binárias carregam o mapa LiDAR, repassadas
sem alteração a partir do computador de bordo (`ros2_ws/`, nó `map_link`).

## Ponte → interface (JSON)

| `type`            | Quando                     | Conteúdo |
|-------------------|----------------------------|----------|
| `hello`           | ao conectar                | `bridge`, `version`, `mavlink` (endereço), `replay` (bool), `log_file` (onde está gravando, ou `null`) |
| `telemetry`       | 10 Hz                      | estado completo do veículo (ver `gcs-web/src/types.ts` → `Telemetry`); `vehicle_class` (`copter`, `heli`, `plane`, `vtol` ou `rover`) diz qual tabela de modos vale |
| `statustext`      | a cada STATUSTEXT          | `severity` (0–7), `text` |
| `ack`             | a cada COMMAND_ACK         | `command` (ex.: `MAV_CMD_NAV_TAKEOFF`), `result` (ex.: `MAV_RESULT_ACCEPTED`) |
| `param`           | a cada PARAM_VALUE         | `id`, `value`, `index`, `count` |
| `mission_upload`  | fim do envio de missão     | `ok`, `result`, `count`, `wp_seq` (seq MAVLink de cada waypoint) |
| `vehicle_mission` | ao achar o veículo, a novos clientes, depois de cada envio e de cada `mission_download` | missão como está no veículo: `items` (`{lat, lon, alt, drop?}`), `wp_seq`, `rtl_at_end`, `land_at_end`, `ignored` (itens que a estação não representa), `count` |
| `replay`          | 2 Hz durante a reprodução e a cada comando `replay` | `file`, `t` e `duration` (s), `speed`, `paused` |
| `calib`           | durante calibrações        | `kind: "accel"` com `status` (`position`, `success`, `failed`) e `position` (1–6); `kind: "compass"` com `compass`, `pct`, `attempt`, `status`; `kind: "compass_report"` com `compass`, `fitness`, `autosaved`, `status` |
| `map_reset`       | mapa zerado                | — |
| `error`           | comando inválido ou recusado | `message`; recusas do pré-voo começam com `pré-voo (decolar)` ou `pré-voo (iniciar missão)` |
| `payload`         | ao conectar, 2 Hz, 10 Hz durante a contagem e a cada mudança | estado do sistema de entrega (ver `PayloadState` em `types.ts`) |
| `payload_release` | a cada lançamento          | `event`: `n` (número no contador), `slot`, `name`, `t`, `lat`, `lon`, `alt_rel`, `groundspeed`, `mass_g`, `source` (`estação`, `missão` ou `externo`), `confirmed` |
| `payload_confirm` | chave confirmou ou o prazo venceu | `event` com `confirmed: true/false` |

## Interface → ponte (JSON, campo `cmd`)

| `cmd`             | Campos | MAVLink gerado |
|-------------------|--------|----------------|
| `arm`             | `arm: bool`, `force?: bool` | `MAV_CMD_COMPONENT_ARM_DISARM` |
| `mode`            | `mode`: nome do modo no firmware do veículo (ex.: `LOITER`, `FBWA`, `QHOVER`) | `MAV_CMD_DO_SET_MODE` com o número do modo na tabela da classe |
| `takeoff`         | `alt` (m, relativa), `force?: bool` | pré-voo da ponte (pulado com `force`); multirrotor/helicóptero: GUIDED → arma → `MAV_CMD_NAV_TAKEOFF`; avião/VTOL: `TKOFF_ALT` = alt → modo TAKEOFF → arma |
| `mission_upload`  | `items: [{lat, lon, alt, drop?}]`, `rtl_at_end?`, `land_at_end?` (asa fixa), `approach_deg?` (rumo final do pouso), `cruise_ms?` (velocidade para o ponto de soltura) | protocolo de missão completo (COUNT → REQUEST_INT → ITEM_INT → ACK) |
| `mission_download`| — | MISSION_REQUEST_LIST → COUNT → REQUEST_INT… → ACK; responde com `vehicle_mission` |
| `mission_start`   | `force?: bool` | pré-voo da ponte se estiver no chão; modo AUTO + `MAV_CMD_MISSION_START` |
| `replay`          | `speed?` (0.1–64), `paused?`, `seek?` (s) | só na reprodução |
| `calibrate`       | `kind`: `gyro`, `accel`, `level`, `compass`, `compass_accept`, `compass_cancel` | `MAV_CMD_PREFLIGHT_CALIBRATION` (giro, acelerômetro 6 posições, nivelar); `MAV_CMD_DO_START_MAG_CAL` / `ACCEPT` / `CANCEL`; só desarmado |
| `accel_pos`       | `position` (1–6) | `MAV_CMD_ACCELCAL_VEHICLE_POS`: confirma a posição pedida pelo veículo |
| `reboot`          | — | `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN`; só desarmado |
| `manual`          | `x, y, z, r` em −1…1 (z em 0…1) | `MANUAL_CONTROL` |
| `param_get`       | `id` | `PARAM_REQUEST_READ` |
| `param_set`       | `id`, `value` | `PARAM_SET` |
| `photo`           | — | `MAV_CMD_DO_DIGICAM_CONTROL` |
| `gimbal`          | `pitch` (graus), `yaw?` | `MAV_CMD_DO_MOUNT_CONTROL` |
| `map_reset`       | — | limpa o histórico do mapa na ponte |
| `payload_arm`     | `arm: bool` | chave geral do sistema de entrega (só na ponte) |
| `payload_release` | `slots: [id]` | contagem regressiva e depois `MAV_CMD_DO_SET_SERVO` (servo) ou `MAV_CMD_DO_SET_RELAY` (solenoide), um por vez |
| `payload_abort`   | — | cancela a contagem |
| `payload_lock`    | `slot` | atuador na posição travada |
| `payload_test`    | `slot` | solta e trava de novo; só com motores desarmados; não conta |
| `payload_loaded`  | `slot`, `loaded: bool` | marca carregado/vazio (sem chave de confirmação) |
| `payload_config`  | `slots: [...]`, `settings: {...}` | substitui a configuração e grava em `entrega.json` |
| `payload_reset_counter` | — | zera o contador e o histórico |
| `payload_get`     | — | pede um `payload` |

### Sistema de entrega

Cada compartimento (`slot`) tem `id`, `name`, `actuator` (`{type:"servo", channel, pwm_locked, pwm_released}`
ou `{type:"relay", relay}`), `switch_bit` (bit da chave em `ENT_SW`, ou `null`), `mass_g`, `enabled`,
`loaded` e `releases`. Os ajustes (`settings`) são `countdown_s` (0–10), `min_alt_m`, `require_armed`,
`relock_s`, `salvo_interval_s` e `mission_hold_s`.

Travas conferidas na ponte antes de começar a contagem, a cada 100 ms durante ela e no instante de soltar:
sistema armado, veículo conectado, motores armados (se `require_armed`), altura ≥ `min_alt_m`,
compartimento ativo e carregado. A contagem é abortada se alguma falhar, se o operador abortar,
se a última interface desconectar ou se o veículo sumir (nesse caso a entrega também é desarmada).

Confirmação: o script `entrega.lua` envia `NAMED_VALUE_FLOAT` `"ENT_SW"` (máscara de bits, bit = 1 →
pino travado). Depois de soltar, a chave tem 2 s para abrir; senão o lançamento fica `confirmed: false`.
A chave fechando de novo marca o compartimento como carregado.

Lançamentos feitos fora da ponte (itens de missão, outro GCS) são detectados pelo `SERVO_OUTPUT_RAW`
quando a saída vai para o PWM "solto", e entram no contador com `source` `missão` ou `externo`.

### Pré-voo e reprodução

Antes de `takeoff` e de `mission_start` no chão, a ponte confere: veículo conectado, GPS com fix 3D e
pelo menos 6 satélites, bateria ≥ 25 % e home definido. `arm` também recusa com bateria abaixo de 25 %.
Na reprodução (`--replay arquivo.tlog`), só `replay`, `map_reset` e `payload_get` são aceitos; o resto
recebe `error` "reproduzindo um voo gravado…". Nada é enviado: a reprodução não tem veículo.

### Gravação (`.tlog`)

Cada mensagem MAVLink recebida é gravada como 8 bytes de tempo (µs desde 1970, big-endian) seguidos
do quadro MAVLink inteiro, o formato `.tlog` do Mission Planner/QGroundControl/pymavlink. Um arquivo
por execução da ponte, `AAAA-MM-DD_hh-mm-ss.tlog` (hora UTC), em `--log-dir`.

### Missão enviada ao veículo

A ponte monta a missão no formato que o firmware espera:

| seq | item |
|-----|------|
| 0   | home (o ArduPilot sobrescreve) |
| 1   | `NAV_TAKEOFF` na altitude do primeiro waypoint (avião: arfagem 15°); VTOL: `NAV_VTOL_TAKEOFF` |
| 2…  | `NAV_WAYPOINT` para cada item da interface |
|     | multirrotor com `drop: [id]`: um `DO_SET_SERVO`/`DO_SET_RELAY` por compartimento, `NAV_LOITER_TIME` de `mission_hold_s` no mesmo ponto e os comandos de travar de novo |
|     | asa fixa com `drop`: `NAV_WAYPOINT` de soltura `v·√(2h/g)·0,85` antes do alvo (raio de aceitação 2 m), os comandos de soltar, o waypoint do alvo e os de travar de novo |
| fim | multirrotor: `NAV_RETURN_TO_LAUNCH` (se `rtl_at_end`) |
|     | avião com `land_at_end`: `DO_LAND_START`, aproximação a 500 m/40 m e 250 m/20 m antes do home no rumo `approach_deg` (ou vindo do último waypoint), `NAV_LAND` no home |
|     | VTOL com `land_at_end`: `NAV_VTOL_LAND` no home |

Ao ler do veículo (`vehicle_mission`), a ponte faz o caminho inverso: reconhece os pontos de soltura
e de aproximação que ela mesma gera e devolve só os waypoints da interface, com os `drop` ligados de
volta aos compartimentos pelo canal do servo ou pelo relé.

Como a entrega acrescenta itens, a resposta `mission_upload` traz `wp_seq`, o `seq` de cada waypoint;
a interface usa essa lista para saber qual waypoint está ativo a partir de `mission_current`.

## Quadros binários do mapa (little-endian)

### `AVX1` — voxels novos

| offset | tipo    | campo |
|--------|---------|-------|
| 0      | 4 bytes | `"AVX1"` |
| 4      | u16     | versão (1) |
| 6      | u16     | flags (bit 0 = zerar mapa antes) |
| 8      | f64     | latitude da origem |
| 16     | f64     | longitude da origem |
| 24     | f32     | altitude da origem (m, MSL) |
| 28     | f32     | tamanho do voxel (m) |
| 32     | u32     | número de voxels `n` |
| 36     | n × 8   | `i16 leste, i16 norte, i16 cima` (em voxels), `u8 classe` (0 solo, 1 obstáculo), `u8 intensidade` |

### `AOB1` — distâncias por setor (anticolisão)

| offset | tipo    | campo |
|--------|---------|-------|
| 0      | 4 bytes | `"AOB1"` |
| 4      | u16     | versão (1) |
| 6      | u16     | número de setores (72) |
| 8      | f32     | largura do setor (graus, 5) |
| 12     | f32     | alcance máximo (m) |
| 16     | n × u16 | distância em cm, setor 0 = proa, sentido horário; `0xFFFF` = sem leitura ou livre |

O `map_link` envia os quadros por UDP em datagramas de até 1400 bytes (`max_datagram_bytes`), para
não fragmentar no rádio: cada `AVX1` leva até 170 voxels. A banda total (`max_kbps`) é um balde de
fichas único; os `AOB1` saem sempre e os voxels usam o que sobra.

Exemplos binários de cada quadro, conferidos pelos testes das três implementações, estão em
[`fixtures/`](fixtures/).
