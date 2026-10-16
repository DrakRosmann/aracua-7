# Protocolo entre ponte e interface

A ponte (`bridge/`) fala MAVLink com o piloto automático e expõe um WebSocket
para a interface (`gcs-web/`). Padrão: `ws://<host>:8765`.

Mensagens de texto são JSON. Mensagens binárias carregam o mapa LiDAR, repassadas
sem alteração a partir do computador de bordo (`ros2_ws/`, nó `map_link`).

## Ponte → interface (JSON)

| `type`            | Quando                     | Conteúdo |
|-------------------|----------------------------|----------|
| `hello`           | ao conectar                | `bridge`, `version`, `mavlink` (endereço) |
| `telemetry`       | 10 Hz                      | estado completo do veículo (ver `gcs-web/src/types.ts` → `Telemetry`) |
| `statustext`      | a cada STATUSTEXT          | `severity` (0–7), `text` |
| `ack`             | a cada COMMAND_ACK         | `command` (ex.: `MAV_CMD_NAV_TAKEOFF`), `result` (ex.: `MAV_RESULT_ACCEPTED`) |
| `param`           | a cada PARAM_VALUE         | `id`, `value`, `index`, `count` |
| `mission_upload`  | fim do envio de missão     | `ok`, `result`, `count`, `wp_seq` (seq MAVLink de cada waypoint) |
| `map_reset`       | mapa zerado                | — |
| `error`           | comando inválido           | `message` |
| `payload`         | ao conectar, 2 Hz, 10 Hz durante a contagem e a cada mudança | estado do sistema de entrega (ver `PayloadState` em `types.ts`) |
| `payload_release` | a cada lançamento          | `event`: `n` (número no contador), `slot`, `name`, `t`, `lat`, `lon`, `alt_rel`, `groundspeed`, `mass_g`, `source` (`estação`, `missão` ou `externo`), `confirmed` |
| `payload_confirm` | chave confirmou ou o prazo venceu | `event` com `confirmed: true/false` |

## Interface → ponte (JSON, campo `cmd`)

| `cmd`             | Campos | MAVLink gerado |
|-------------------|--------|----------------|
| `arm`             | `arm: bool`, `force?: bool` | `MAV_CMD_COMPONENT_ARM_DISARM` |
| `mode`            | `mode: "STABILIZE"\|"ALT_HOLD"\|"LOITER"\|"POSHOLD"\|"GUIDED"\|"AUTO"\|"RTL"\|"LAND"\|"BRAKE"` | `MAV_CMD_DO_SET_MODE` (modo customizado ArduCopter) |
| `takeoff`         | `alt` (m, relativa) | modo GUIDED → arma se preciso → `MAV_CMD_NAV_TAKEOFF` |
| `mission_upload`  | `items: [{lat, lon, alt}]`, `rtl_at_end?: bool` | protocolo de missão completo (COUNT → REQUEST_INT → ITEM_INT → ACK) |
| `mission_start`   | — | modo AUTO + `MAV_CMD_MISSION_START` |
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

### Missão enviada ao veículo

A ponte monta a missão no formato que o ArduCopter espera:

| seq | item |
|-----|------|
| 0   | home (o ArduPilot sobrescreve) |
| 1   | `NAV_TAKEOFF` na altitude do primeiro waypoint |
| 2…  | `NAV_WAYPOINT` para cada item da interface |
|     | se o item tem `drop: [id]`: um `DO_SET_SERVO`/`DO_SET_RELAY` por compartimento, `NAV_LOITER_TIME` de `mission_hold_s` no mesmo ponto e os comandos de travar de novo |
| fim | `NAV_RETURN_TO_LAUNCH` (se `rtl_at_end`) |

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
