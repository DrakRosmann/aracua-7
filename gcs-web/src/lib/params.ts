// Parâmetros mostrados em Configurar, por tipo de veículo. Cada firmware tem os
// seus nomes e unidades (RTL_ALT em cm no ArduCopter, RTL_ALTITUDE em m no ArduPlane…).

import type { VehicleClass } from '../types'

export type Kind =
  | { t: 'number'; unit?: string; scale?: number; min: number; max: number; step?: number }
  | { t: 'bool' }
  | { t: 'select'; options: [number, string][] }

export interface PField {
  id: string
  label: string
  desc?: string
  kind: Kind
}

export interface PCard {
  title: string
  fields: PField[]
}

const fence: PCard = {
  title: 'Geocerca',
  fields: [
    { id: 'FENCE_ENABLE', label: 'Geocerca ativa', kind: { t: 'bool' } },
    { id: 'FENCE_RADIUS', label: 'Raio máximo', desc: 'distância do home', kind: { t: 'number', unit: 'm', min: 30, max: 10000 } },
  ],
}

const COPTER_SAFETY: PCard[] = [
  fence,
  {
    title: 'Retorno e energia',
    fields: [
      { id: 'RTL_ALT', label: 'Altitude de retorno', desc: 'sobe até ela antes de voltar', kind: { t: 'number', unit: 'm', scale: 100, min: 2, max: 300 } },
      { id: 'BATT_LOW_MAH', label: 'Reserva de bateria', desc: 'failsafe abaixo desta carga', kind: { t: 'number', unit: 'mAh', min: 0, max: 20000, step: 50 } },
      { id: 'BATT_FS_LOW_ACT', label: 'Ação com bateria baixa', kind: { t: 'select', options: [[0, 'Só avisar'], [1, 'Pousar'], [2, 'Retornar (RTL)'], [3, 'SmartRTL ou RTL'], [4, 'SmartRTL ou pousar']] } },
      { id: 'FS_GCS_ENABLE', label: 'Perda da estação de solo', kind: { t: 'select', options: [[0, 'Desligado'], [1, 'Retornar (RTL)'], [3, 'SmartRTL ou RTL'], [5, 'Pousar']] } },
    ],
  },
  {
    title: 'Anticolisão (LiDAR via OBSTACLE_DISTANCE)',
    fields: [
      { id: 'AVOID_ENABLE', label: 'Anticolisão', kind: { t: 'select', options: [[0, 'Desligada'], [7, 'Ligada (cerca + proximidade)']] } },
      { id: 'AVOID_DIST_MAX', label: 'Distância de frenagem', kind: { t: 'number', unit: 'm', min: 1, max: 30 } },
    ],
  },
]

const PLANE_SAFETY: PCard[] = [
  fence,
  {
    title: 'Retorno e pouso',
    fields: [
      { id: 'RTL_ALTITUDE', label: 'Altitude de retorno', kind: { t: 'number', unit: 'm', min: 10, max: 500 } },
      { id: 'RTL_AUTOLAND', label: 'Pousar ao retornar', desc: 'usa a sequência de pouso da missão (DO_LAND_START)', kind: { t: 'select', options: [[0, 'Não: circula no home'], [1, 'Volta ao home e pousa'], [2, 'Vai direto à sequência de pouso']] } },
    ],
  },
  {
    title: 'Energia e perda de link',
    fields: [
      { id: 'BATT_LOW_MAH', label: 'Reserva de bateria', kind: { t: 'number', unit: 'mAh', min: 0, max: 20000, step: 50 } },
      { id: 'BATT_FS_LOW_ACT', label: 'Ação com bateria baixa', kind: { t: 'select', options: [[0, 'Só avisar'], [1, 'Retornar (RTL)'], [2, 'Pousar'], [4, 'Pouso vertical (QLand)']] } },
      { id: 'FS_LONG_ACTN', label: 'Perda longa do rádio', kind: { t: 'select', options: [[0, 'Continuar'], [1, 'Retornar (RTL)'], [2, 'Planar'], [3, 'Paraquedas']] } },
      { id: 'FS_LONG_TIMEOUT', label: 'Tempo até a perda longa', kind: { t: 'number', unit: 's', min: 1, max: 300 } },
      { id: 'FS_GCS_ENABL', label: 'Perda da estação de solo', kind: { t: 'select', options: [[0, 'Desligado'], [1, 'Sem HEARTBEAT'], [2, 'HEARTBEAT ou RSSI do rádio'], [3, 'HEARTBEAT, inclusive em AUTO']] } },
    ],
  },
]

const ROVER_SAFETY: PCard[] = [
  fence,
  {
    title: 'Energia',
    fields: [
      { id: 'BATT_LOW_MAH', label: 'Reserva de bateria', kind: { t: 'number', unit: 'mAh', min: 0, max: 20000, step: 50 } },
      { id: 'FS_GCS_ENABLE', label: 'Perda da estação de solo', kind: { t: 'select', options: [[0, 'Desligado'], [1, 'Ligado']] } },
    ],
  },
]

const COPTER_FLIGHT: PCard = {
  title: 'Velocidades',
  fields: [
    { id: 'WPNAV_SPEED', label: 'Velocidade em missão', kind: { t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 20, step: 0.5 } },
    { id: 'LOIT_SPEED', label: 'Velocidade máxima manual', desc: 'modo Posição', kind: { t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 20, step: 0.5 } },
    { id: 'PILOT_SPEED_UP', label: 'Velocidade de subida', kind: { t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 8, step: 0.5 } },
    { id: 'PILOT_TKOFF_ALT', label: 'Altitude de decolagem pelo rádio', kind: { t: 'number', unit: 'm', scale: 100, min: 0, max: 100 } },
  ],
}

const HELI_ROTOR: PCard = {
  title: 'Rotor principal (TradHeli)',
  fields: [
    { id: 'H_RSC_MODE', label: 'Controle do motor do rotor', kind: { t: 'select', options: [[1, 'Passagem do canal 8'], [2, 'Ponto fixo'], [3, 'Curva de acelerador'], [4, 'Governador interno']] } },
    { id: 'H_RSC_SETPOINT', label: 'Rotação alvo', desc: 'modo ponto fixo', kind: { t: 'number', unit: '%', min: 0, max: 100 } },
    { id: 'H_RSC_RUNUP_TIME', label: 'Tempo de aceleração do rotor', kind: { t: 'number', unit: 's', min: 0, max: 60 } },
    { id: 'H_COL_MIN', label: 'Coletivo mínimo', kind: { t: 'number', unit: 'µs', min: 1000, max: 2000 } },
    { id: 'H_COL_MAX', label: 'Coletivo máximo', kind: { t: 'number', unit: 'µs', min: 1000, max: 2000 } },
  ],
}

const PLANE_FLIGHT: PCard[] = [
  {
    title: 'Velocidade no ar',
    fields: [
      { id: 'AIRSPEED_CRUISE', label: 'Velocidade de cruzeiro', kind: { t: 'number', unit: 'm/s', min: 5, max: 60, step: 0.5 } },
      { id: 'AIRSPEED_MIN', label: 'Velocidade mínima', desc: 'acima da de estol', kind: { t: 'number', unit: 'm/s', min: 5, max: 50 } },
      { id: 'AIRSPEED_MAX', label: 'Velocidade máxima', kind: { t: 'number', unit: 'm/s', min: 5, max: 80 } },
    ],
  },
  {
    title: 'Decolagem, navegação e pouso',
    fields: [
      { id: 'TKOFF_ALT', label: 'Altitude da decolagem automática', kind: { t: 'number', unit: 'm', min: 5, max: 300 } },
      { id: 'TKOFF_THR_MAX', label: 'Acelerador máximo na decolagem', kind: { t: 'number', unit: '%', min: 0, max: 100 } },
      { id: 'WP_RADIUS', label: 'Raio de chegada no waypoint', kind: { t: 'number', unit: 'm', min: 1, max: 300 } },
      { id: 'WP_LOITER_RAD', label: 'Raio dos círculos', desc: 'LOITER e RTL; negativo = anti-horário', kind: { t: 'number', unit: 'm', min: -500, max: 500 } },
      { id: 'ROLL_LIMIT_DEG', label: 'Inclinação máxima nas curvas', kind: { t: 'number', unit: '°', min: 10, max: 70 } },
      { id: 'LAND_FLARE_ALT', label: 'Altura do arredondamento', desc: 'onde o avião levanta o nariz para tocar', kind: { t: 'number', unit: 'm', min: 0, max: 30, step: 0.5 } },
    ],
  },
]

const VTOL_FLIGHT: PCard = {
  title: 'VTOL (QuadPlane)',
  fields: [
    { id: 'Q_ENABLE', label: 'Rotores de pairar ativos', kind: { t: 'bool' } },
    { id: 'Q_ASSIST_SPEED', label: 'Ajuda dos rotores abaixo de', desc: '0 = nunca ajuda', kind: { t: 'number', unit: 'm/s', min: 0, max: 40 } },
    { id: 'Q_RTL_MODE', label: 'Fim do RTL', kind: { t: 'select', options: [[0, 'Circula como avião'], [1, 'Pousa na vertical (QRTL)'], [2, 'Aproximação VTOL'], [3, 'Sempre QRTL']] } },
    { id: 'Q_WP_SPEED', label: 'Velocidade pairando', kind: { t: 'number', unit: 'm/s', scale: 100, min: 0.5, max: 20, step: 0.5 } },
    { id: 'Q_LAND_SPEED', label: 'Velocidade de descida no pouso', kind: { t: 'number', unit: 'm/s', scale: 100, min: 0.2, max: 3, step: 0.1 } },
    { id: 'Q_TRANSITION_MS', label: 'Duração da transição', kind: { t: 'number', unit: 's', scale: 1000, min: 1, max: 30 } },
  ],
}

const ROVER_FLIGHT: PCard = {
  title: 'Velocidades',
  fields: [
    { id: 'CRUISE_SPEED', label: 'Velocidade de cruzeiro', kind: { t: 'number', unit: 'm/s', min: 0.2, max: 30, step: 0.1 } },
    { id: 'WP_SPEED', label: 'Velocidade em missão', kind: { t: 'number', unit: 'm/s', min: 0, max: 30, step: 0.1 } },
    { id: 'WP_RADIUS', label: 'Raio de chegada no waypoint', kind: { t: 'number', unit: 'm', min: 0.5, max: 100 } },
  ],
}

export function safetyCards(cls: VehicleClass): PCard[] {
  if (cls === 'plane' || cls === 'vtol') return PLANE_SAFETY
  if (cls === 'rover') return ROVER_SAFETY
  return COPTER_SAFETY
}

export function flightCards(cls: VehicleClass): PCard[] {
  switch (cls) {
    case 'copter': return [COPTER_FLIGHT]
    case 'heli': return [COPTER_FLIGHT, HELI_ROTOR]
    case 'plane': return PLANE_FLIGHT
    case 'vtol': return [...PLANE_FLIGHT, VTOL_FLIGHT]
    case 'rover': return [ROVER_FLIGHT]
  }
}

/** Parâmetro com a altitude de retorno e a escala para metros. */
export function rtlAltParam(cls: VehicleClass): [string, number] {
  return cls === 'plane' || cls === 'vtol' ? ['RTL_ALTITUDE', 1] : ['RTL_ALT', 100]
}

/** Tudo o que a interface lê ao conectar num veículo deste tipo. */
export function paramIdsFor(cls: VehicleClass): string[] {
  const ids = new Set<string>(['BATT_LOW_MAH', 'FENCE_ENABLE', 'FENCE_RADIUS', 'FENCE_TYPE', 'AVOID_ENABLE', 'AVOID_DIST_MAX', 'RCMAP_THROTTLE', rtlAltParam(cls)[0]])
  for (const c of [...safetyCards(cls), ...flightCards(cls)]) for (const f of c.fields) ids.add(f.id)
  return [...ids]
}
