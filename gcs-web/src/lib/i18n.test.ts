// Toda chave usada com t('…') precisa estar no dicionário inglês.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EN } from './i18n-en'
import { setLang, t } from './i18n'
import { flightCards, safetyCards } from './params'
import type { VehicleClass } from '../types'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : []
  })
}

/** Chaves literais: t('…') e t("…"), sem interpolação. */
export function keysIn(src: string): string[] {
  const out: string[] = []
  const re = /\b(?:t|tk|tr)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
  for (const m of src.matchAll(re)) out.push(m[2].replace(/\\(['"\\])/g, '$1'))
  return out
}

describe('i18n', () => {
  const src = new URL('..', import.meta.url).pathname
  const all = files(src).flatMap((f) => keysIn(readFileSync(f, 'utf8')).map((k) => [k, f] as const))

  it('encontra chaves no código', () => {
    expect(all.length).toBeGreaterThan(50)
  })

  it('todas as chaves têm tradução para o inglês', () => {
    const missing = [...new Set(all.filter(([k]) => !(k in EN)).map(([k, f]) => `${f.replace(src, '')}: ${k}`))]
    expect(missing).toEqual([])
  })

  it('os parâmetros de todos os tipos de veículo têm tradução', () => {
    const classes: VehicleClass[] = ['copter', 'heli', 'plane', 'vtol', 'rover']
    const texts = classes.flatMap((c) => [...safetyCards(c), ...flightCards(c)]).flatMap((card) => [
      card.title, ...card.fields.flatMap((f) => [f.label, f.desc ?? '', ...(f.kind.t === 'select' ? f.kind.options.map(([, l]) => l) : [])]),
    ]).filter(Boolean)
    expect([...new Set(texts.filter((k) => !(k in EN)))]).toEqual([])
  })

  it('as traduções mantêm as variáveis {x}', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    const wrong = Object.entries(EN).filter(([pt, en]) => vars(pt) !== vars(en)).map(([pt]) => pt)
    expect(wrong).toEqual([])
  })

  it('troca a língua e preenche variáveis', () => {
    setLang('en')
    expect(t('Decolar')).toBe(EN['Decolar'] ?? 'Decolar')
    setLang('pt')
    expect(t('Decolar até {alt} m', { alt: 20 })).toBe('Decolar até 20 m')
  })
})
