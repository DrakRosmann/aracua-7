# Aracuã-7 — hwdef para ArduPilot

* `hwdef.dat` — pinagem e periféricos do firmware (STM32H743ZIT6, LQFP144)
* `hwdef-bl.dat` — bootloader
* `defaults.parm` — parâmetros padrão (quad X, DShot bidirecional, GPS duplo, anticolisão)
* `pinagem_kicad.csv` — os 144 pinos físicos com net, função e destino, para montar o esquemático
* `scripts/entrega.lua` — lê as chaves dos compartimentos de entrega e envia o estado à estação (copie para `APM/scripts/` no microSD)

## Como compilar

```bash
git clone --recursive https://github.com/ArduPilot/ardupilot.git
cp -r Aracua7 ardupilot/libraries/AP_HAL_ChibiOS/hwdef/
cd ardupilot
Tools/environment_install/install-prereqs-ubuntu.sh -y   # ou o equivalente para Fedora/Arch
Tools/scripts/build_bootloaders.py Aracua7
./waf configure --board Aracua7
./waf copter
```

O ID de placa 7108 é provisório. Para distribuir o firmware, reserve um ID por pull request
em `Tools/AP_Bootloader/board_types.txt`.

## O que já foi verificado

* Todas as funções existem nos pinos escolhidos (tabela de funções alternativas do STM32H743 do ArduPilot).
* `chibios_hwdef.py` processou o `hwdef.dat` sem erro de pino e gerou o `hwdef.h` com o mapa de DMA.
* `hwdef-bl.dat` gerou a configuração completa do bootloader.
* Os números físicos vêm do símbolo `STM32H743ZITx` da biblioteca oficial do KiCad; confira contra o datasheet DS12110 antes de fabricar.

## Sistema de entrega

| Compartimento | Saída | Pino | Chave | Pino da chave |
|---|---|---|---|---|
| ENT1 | SERVO5 | PD12 (TIM4_CH1) | SW1 | PF0 · GPIO 101 |
| ENT2 | SERVO6 | PD13 (TIM4_CH2) | SW2 | PF1 · GPIO 102 |
| ENT3 | SERVO7 | PD14 (TIM4_CH3) | SW3 | PF2 · GPIO 103 |
| ENT4 | SERVO8 | PD15 (TIM4_CH4) | SW4 | PF3 · GPIO 104 |
| ENT5 | SERVO10 | PF6 (TIM16_CH1) | SW5 | PF10 · GPIO 105 |
| ENT6 | SERVO11 | PF7 (TIM17_CH1) | SW6 | PF11 · GPIO 106 |
| SOL1 | RELAY3 (instância 2) | PG2 · GPIO 83 | — | — |
| SOL2 | RELAY4 (instância 3) | PG3 · GPIO 84 | — | — |
| VSERVO | RELAY5 / PINIO3 | PG8 · GPIO 85 | — | — |

* Os servos ficam com `SERVOn_FUNCTION = 0`; a estação os move com `MAV_CMD_DO_SET_SERVO`
  (canal, PWM). Os solenoides usam `MAV_CMD_DO_SET_RELAY`.
* Itens de missão `DO_SET_SERVO` também soltam a carga num waypoint, sem depender do rádio.
* `entrega.lua` envia `NAMED_VALUE_FLOAT` com nome `ENT_SW` a 5 Hz; o bit *n* ligado significa
  que o compartimento *n+1* está com o pino travado.
