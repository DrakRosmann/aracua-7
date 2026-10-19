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
| `telemetry`       | 10 Hz                      | estado completo do veículo (ver `gcs-web/src/types.ts` → `Telemetry`); `vehicle_class` (`copter`, `heli`, `plane`, `vtol` ou `rover`) diz qual tabela de modos vale; `ap` é o estado do piloto automático (abaixo) |
| `statustext`      | a cada STATUSTEXT          | `severity` (0–7), `text` |
| `ack`             | a cada COMMAND_ACK         | `command` (ex.: `MAV_CMD_NAV_TAKEOFF`), `result` (ex.: `MAV_RESULT_ACCEPTED`) |
| `param`           | a cada PARAM_VALUE         | `id`, `value`, `index`, `count` |
| `mission_upload`  | fim do envio de missão     | `ok`, `result`, `count`, `wp_seq` (seq MAVLink de cada waypoint) |
| `vehicle_mission` | ao achar o veículo, a novos clientes, depois de cada envio e de cada `mission_download` | missão como está no veículo: `items` (`{lat, lon, alt, drop?}`), `wp_seq`, `rtl_at_end`, `land_at_end`, `ignored` (itens que a estação não representa), `count` |
| `replay`          | 2 Hz durante a reprodução e a cada comando `replay` | `file`, `t` e `duration` (s), `speed`, `paused` |
| `calib`           | durante calibrações        | `kind: "accel"` com `status` (`position`, `success`, `failed`) e `position` (1–6); `kind: "compass"` com `compass`, `pct`, `attempt`, `status`; `kind: "compass_report"` com `compass`, `fitness`, `autosaved`, `status` |
| `vehicle_fence`   | ao ler a geocerca do veículo (depois da missão, ao conectar) e depois de cada envio | `inclusion` e `exclusion` (listas de polígonos `[{lat, lon}]`), `circles_inclusion` e `circles_exclusion` (`{lat, lon, radius}`) |
| `fence_upload`    | fim do envio da geocerca   | `ok`, `result`, `count` |
| `maintenance`     | ao conectar, a cada 10 s, no fim de cada voo e depois de cada comando de manutenção | registro de manutenção: totais, `batteries`, `active_battery`, `tasks` (com `since_h`, `since_flights`, `used`, `due`), `history`, `notes`, `flying_s` |
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
| `fence_upload`    | `fence` (formato de `vehicle_fence`), `enable?` (padrão true) | protocolo de missão com `mission_type = FENCE`: um item `NAV_FENCE_POLYGON_VERTEX_INCLUSION/EXCLUSION` por vértice (param1 = nº de vértices) e `NAV_FENCE_CIRCLE_*` (param1 = raio); `FENCE_TYPE \|= 4` e `FENCE_ENABLE = 1` |
| `fence_download`  | — | REQUEST_LIST/REQUEST_INT com `mission_type = FENCE`; responde com `vehicle_fence` |
| `autopilot`       | `engage?`, `lateral?` (`hdg`, `nav`), `vertical?` (`alt`, `vs`), `hdg?` (graus), `alt?` (ALT SEL, m acima do home), `vs?` (m/s), `spd?` (m/s), `spd_on?` | piloto automático (abaixo): modo GUIDED (ou AUTO no NAV) e os alvos de cada tipo de veículo |
| `maintenance_get` | — | pede um `maintenance` |
| `maintenance_config` | `airframe`, `batteries` (`id`, `name`, `cycles`, `max_cycles`, `retired`), `active_battery`, `tasks` (`id`, `name`, `every_h`, `every_flights`) | substitui a configuração (totais e histórico ficam) |
| `maintenance_done`| `task`, `note?` | zera a contagem da tarefa e anota |
| `maintenance_note`| `text` | anotação livre |
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

### Motor e energia (`telemetry.propulsion`)

A ponte junta as mensagens de motor e energia do piloto automático em `propulsion` (ver `Propulsion` em
`types.ts`); a interface monta o painel do motor e as faixas a partir dele.

| Campo | Vem de | Conteúdo |
|-------|--------|----------|
| `batteries` | `BATTERY_STATUS` (uma por `id`) | `voltage`, `current` (negativa carregando), `consumed_mah`, `energy_wh`, `remaining`, `temperature`, `cells` (V de cada célula, até 14; vazia se a bateria só manda o total), `time_remaining_s`, `charge_state`, `faults`, `function` |
| `escs` | `ESC_TELEMETRY_1_TO_4` … `13_TO_16` | por ESC (`n` a partir de 1): `rpm`, `temperature`, `voltage`, `current`, `consumed_mah` |
| `efi` | `EFI_STATUS` | injeção de motor a pistão ou ECU de turbina: `rpm`, `cht`, `egt`, `fuel_flow` (cm³/min), `fuel_consumed` (cm³), `throttle`, `engine_load`, pressões e temperaturas de admissão, `ignition_voltage`, `fuel_pressure`, `healthy` |
| `generator` | `GENERATOR_STATUS` | `status` (bits ligados, ex. `generating`, `charging`, `overtemp_fault`), `rpm`, `power_w`, `bus_voltage`, `battery_current`, `load_current`, temperaturas do gerador e do retificador, `runtime_s`, `maintenance_s` |
| `rpm` | `RPM` | sensores de rotação 1 e 2 |
| `named` | `NAMED_VALUE_FLOAT`/`INT` | último valor de cada nome (até 64 nomes) |

Valores sem leitura chegam como `null`; cada item traz `age_ms`. ESCs e baterias sem mensagem por 10 s saem
da lista; EFI, gerador, RPM e valores nomeados, depois de 60 s. Trocar de veículo (outro SYSID ou tipo) zera tudo.

Sensores sem mensagem própria entram por `NAMED_VALUE_FLOAT` (script Lua), com estes nomes:

| Nome | Significado |
|------|-------------|
| `CHT1`…`CHT8`, `EGT1`…`EGT8` | temperatura do cabeçote e do escape por cilindro (°C); sem `CHT1`, a da EFI é o cilindro 1 |
| `H2O` ou `COOLANT` | temperatura da água (°C) |
| `OILT`, `OILP` | temperatura (°C) e pressão (bar) do óleo |
| `FUEL` | nível do tanque (%); sem ele, a interface usa o consumo da EFI e a capacidade do tanque configurada |
| `PUMP_V` | tensão da bomba de combustível da turbina (V) |
| `TURB_ST` | estado da turbina: 0 desligada, 1 pronta, 2 ignição, 3 acelerando, 4 funcionando, 5 resfriando, 6 falha |

O tipo de motor é detectado assim (ou escolhido em **Configurar → Motor**): `TURB_ST` ou rotação da EFI acima
de 25 000 rpm → turbina; outra EFI → combustão; senão, elétrico. O gerador aparece em qualquer tipo.

### Piloto automático

A ponte faz o papel do painel de modos de um avião (MCP). Estado em `telemetry.ap`: `engaged`, `lateral`
(`hdg` ou `nav`), `vertical` (`alt`, `vs` ou `nav`), `hdg` (HDG SEL), `alt_sel` (ALT SEL), `alt_hold` (o que o
ALT segura), `vs`, `spd`, `spd_on` e `message` (por que desligou sozinho; `null` se foi o operador).

* Liga só em voo (armado, acima de 2 m), segurando o rumo, a altitude e a velocidade atuais. Os valores podem
  ser escolhidos antes de ligar.
* **HDG** voa o rumo selecionado; **NAV** segue a missão (modo AUTO, altitudes da missão); **ALT** segura a
  altitude de quando foi apertado; **V/S** sobe ou desce até a ALT SEL no ritmo escolhido e vira ALT ao chegar
  (±0,5 m no multirrotor, ±2 m no avião); **SPD** (avião) mantém a velocidade escolhida, senão `AIRSPEED_CRUISE`.
* Avião e VTOL em voo horizontal: modo GUIDED e `COMMAND_INT` `MAV_CMD_GUIDED_CHANGE_HEADING` (rumo, aceleração
  lateral 6 m/s²), `_ALTITUDE` (relativa ao home, ritmo = V/S ou 0 no ALT) e `_SPEED` (velocidade do ar), do
  ArduPlane 4.5 em diante. Reenviados a cada 3 s.
* Multirrotor e helicóptero: modo GUIDED e `SET_POSITION_TARGET_LOCAL_NED` a 5 Hz com velocidade
  (norte/leste no rumo, vertical por um controle proporcional limitado ao V/S ou a 2,5 m/s) e rumo.
* Desliga sozinho, com `error` "piloto automático desligado: …", se o veículo sair do modo esperado por mais de
  2,5 s (rádio, failsafe, outra estação), desarmar ou perder a conexão. Desligado pelo operador, a ponte põe o
  veículo em LOITER (multirrotor segura a posição, avião circula).

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
