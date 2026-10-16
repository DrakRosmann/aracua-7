// Sistema de entrega: painel de voo, contagem regressiva, configuração dos compartimentos,
// histórico de lançamentos e escolha de entregas no plano de missão.

import { useEffect, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { clamp, clock } from '../lib/format'
import { Icon } from './Icons'
import type { Actuator, PayloadSettings, PayloadSlot, ReleaseEvent } from '../types'
import { t as tr } from '../lib/i18n'

/** Saídas de servo livres na placa Aracuã-7 (1–4 motores, 9 LED). */
const SERVO_OUTPUTS = [5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]
/** Relés da placa: instância 2 = SOL1 (PG2), 3 = SOL2 (PG3). */
const RELAYS: [number, string][] = [[2, 'SOL1 · RELAY3'], [3, 'SOL2 · RELAY4'], [0, 'RELAY1'], [1, 'RELAY2'], [4, 'RELAY5'], [5, 'RELAY6']]

const kg = (g: number) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`)
const actuatorLabel = (a: Actuator) => (a.type === 'servo' ? tr('Servo · saída {n}', { n: a.channel }) : `${tr('Solenoide')} · ${RELAYS.find(([r]) => r === a.relay)?.[1] ?? tr('relé {n}', { n: a.relay })}`)

/** Motivo pelo qual os compartimentos não podem ser soltos agora (mesmas travas da ponte). */
function blockReason(ids: number[]): string | null {
  const p = station.payload, t = station.telem
  if (station.conn !== 'open' || !p) return tr('Sem conexão com a ponte')
  if (station.replay) return tr('Reproduzindo um voo gravado')
  if (!t?.connected) return tr('Sem conexão com o veículo')
  if (p.countdown) return tr('Contagem em andamento')
  if (!p.armed) return tr('Sistema de entrega desarmado')
  if (p.settings.require_armed && !t.armed) return tr('Motores desarmados')
  if (p.settings.min_alt_m > 0 && t.alt_rel < p.settings.min_alt_m) return tr('Abaixo da altura mínima ({min_alt_m} m)', { min_alt_m: p.settings.min_alt_m })
  if (!ids.length) return tr('Nenhum compartimento carregado')
  for (const id of ids) {
    const s = p.slots.find((x) => x.id === id)
    if (!s) return tr('Compartimento não existe')
    if (!s.enabled) return tr('{name} desativado', { name: s.name })
    if (!s.loaded) return tr('{name} vazio', { name: s.name })
  }
  return null
}

/** Botão que pede um segundo clique em até 3 s. */
function ConfirmButton({ className, label, confirmLabel, onConfirm, disabled, title }: {
  className?: string; label: React.ReactNode; confirmLabel: string; onConfirm: () => void; disabled?: boolean; title?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])
  return (
    <button className={`${className ?? 'btn'} ${armed ? 'confirming' : ''}`} disabled={disabled} title={title}
      onClick={() => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) }}>
      {armed ? confirmLabel : label}
    </button>
  )
}

function SwitchState({ s }: { s: PayloadSlot }) {
  if (s.switch_bit == null) return <span className="sw none" title={tr('Sem chave de confirmação')}>{tr('sem chave')}</span>
  if (s.switch_locked == null) return <span className="sw none" title={tr('Chave SW{v0} sem leitura', { v0: s.switch_bit + 1 })}>SW{s.switch_bit + 1} ?</span>
  return s.switch_locked
    ? <span className="sw locked" title={tr('Chave SW{n}: pino travado', { n: s.switch_bit + 1 })}>{tr('pino ✓')}</span>
    : <span className="sw open" title={tr('Chave SW{n}: pino fora', { n: s.switch_bit + 1 })}>{tr('pino fora')}</span>
}

/** Painel flutuante na tela de voo. */
export function DeliveryPanel() {
  useChannels('payload', 'telemetry', 'conn', 'ui')
  const [collapsed, setCollapsed] = useState(innerWidth < 760)
  const [sel, setSel] = useState<number[]>([])
  const p = station.payload
  if (!station.deliveryOpen) return null
  const slots = p?.slots.filter((s) => s.enabled) ?? []
  const loadedIds = slots.filter((s) => s.loaded).map((s) => s.id)
  const selIds = sel.filter((id) => loadedIds.includes(id))
  const instant = (p?.settings.countdown_s ?? 0) === 0
  const release = (ids: number[]) => station.send({ cmd: 'payload_release', slots: ids })
  const reasonAll = blockReason(loadedIds)
  const reasonSel = blockReason(selIds)
  const global = blockReason(loadedIds.length ? [loadedIds[0]] : [])
  const releaseBtn = (ids: number[], label: React.ReactNode, cls: string, reason: string | null) =>
    instant ? (
      <ConfirmButton className={cls} label={label} confirmLabel={tr('Confirmar: soltar já')} disabled={!!reason} title={reason ?? tr('Sem contagem: clique de novo para confirmar')} onConfirm={() => release(ids)} />
    ) : (
      <button className={cls} disabled={!!reason} title={reason ?? tr('Contagem de {countdown_s} s; Esc aborta', { countdown_s: p?.settings.countdown_s ?? '—' })} onClick={() => release(ids)}>{label}</button>
    )

  return (
    <aside className={`dp ${collapsed ? 'collapsed' : ''} ${p?.armed ? 'hot' : ''}`} aria-label={tr('Sistema de entrega')}>
      <button className="rp-h" onClick={() => setCollapsed(!collapsed)}>
        <Icon.chevronUp />{tr('Entrega')}
        <span className={`dstate ${p?.armed ? 'on' : ''}`}>{p ? (p.armed ? tr('ARMADA') : tr('DESARMADA')) : '—'}</span>
      </button>
      {!collapsed && (
        <div className="rp-b">
          <div className="vals">
            <div className="val"><span>{tr('Lançamentos')}</span><b>{p?.total ?? '—'}</b></div>
            <div className="val"><span>{tr('A bordo')}</span><b>{p ? `${p.loaded}/${slots.length}` : '—'}<small>{p ? kg(p.onboard_g) : ''}</small></b></div>
          </div>
          <div className="db top-line">
            {p?.armed ? (
              <button className="btn wide" onClick={() => station.send({ cmd: 'payload_arm', arm: false })}>{tr('Desarmar entrega')}</button>
            ) : (
              <ConfirmButton className="btn wide armbtn" label={tr('Armar entrega')} confirmLabel={tr('Confirmar: armar entrega')}
                disabled={!p || !station.telem?.connected || !!station.replay} title={station.replay ? tr('Reproduzindo um voo gravado') : !station.telem?.connected ? tr('Sem veículo') : tr('Libera os botões de soltar')}
                onConfirm={() => station.send({ cmd: 'payload_arm', arm: true })} />
            )}
            <div className="hint">
              {p ? <>{p.settings.countdown_s ? tr('Contagem {s} s', { s: p.settings.countdown_s }) : tr('Contagem desligada')} · {tr('altura mín. {m} m', { m: p.settings.min_alt_m })}{p.settings.require_armed ? tr(' · só em voo') : ''}</> : tr('Aguardando a ponte…')}
              {p && !p.switches_ok && slots.some((s) => s.switch_bit != null) && <><br /><span className="warn">Sem leitura das chaves (entrega.lua rodando?)</span></>}
            </div>
          </div>
          <div className="slots">
            {slots.map((s) => {
              const r = blockReason([s.id])
              return (
                <div key={s.id} className={`slot ${s.loaded ? 'loaded' : 'empty'} ${p?.countdown?.slots.includes(s.id) ? 'counting' : ''}`}>
                  <input type="checkbox" aria-label={tr('Selecionar {name}', { name: s.name })} checked={s.loaded && sel.includes(s.id)} disabled={!s.loaded}
                    onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />
                  <div className="sname">
                    <b>{s.name}</b>
                    <small>{s.loaded ? tr('carregado') : tr('vazio')}{s.mass_g ? ` · ${kg(s.mass_g)}` : ''} · {s.releases}×</small>
                  </div>
                  <SwitchState s={s} />
                  {releaseBtn([s.id], tr('Soltar'), 'btn rel', r)}
                </div>
              )
            })}
            {p && !slots.length && <div className="empty">{tr('Nenhum compartimento ativo. Adicione em Configurar → Entrega.')}</div>}
          </div>
          <div className="db top-line">
            <div className="brow">
              {releaseBtn(selIds, tr('Soltar selecionados') + (selIds.length ? ` (${selIds.length})` : ''), 'btn rel', selIds.length ? reasonSel : tr('Marque os compartimentos'))}
              {releaseBtn(loadedIds, tr('Soltar todos ({n})', { n: loadedIds.length }), 'btn rel', loadedIds.length > 1 ? reasonAll : tr('Menos de dois carregados'))}
            </div>
            {global && p?.armed && <div className="hint warn">{global}</div>}
            {p?.message && <div className="hint warn">{p.message}</div>}
          </div>
        </div>
      )}
    </aside>
  )
}

/** Contagem regressiva grande no centro da tela, com aborto por botão ou Esc. */
export function CountdownOverlay() {
  useChannels('payload')
  const c = station.payload?.countdown ?? null
  const counting = c !== null
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!counting) return
    const id = setInterval(() => setNow(performance.now()), 50)
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); station.send({ cmd: 'payload_abort' }) } }
    document.addEventListener('keydown', k)
    return () => { clearInterval(id); document.removeEventListener('keydown', k) }
  }, [counting])
  if (!c) return null
  // O relógio local parte do último estado recebido da ponte (payloadAt).
  const left = Math.max(0, Math.min(c.remaining_ms, c.remaining_ms - (now - station.payloadAt)))
  const frac = c.total_ms ? left / c.total_ms : 0
  const names = c.slots.map((id) => station.payloadName(id)).join(' · ')
  const R = 70, L = 2 * Math.PI * R
  return (
    <div className="cd" role="alertdialog" aria-live="assertive" aria-label={tr('Soltando {names} em {v1} segundos', { names, v1: Math.ceil(left / 1000) })}>
      <div className="cdh">{tr('Soltando {names}', { names })}</div>
      <svg viewBox="0 0 160 160" className="cdring" aria-hidden="true">
        <circle cx="80" cy="80" r={R} className="bg" />
        <circle cx="80" cy="80" r={R} className="fg" style={{ strokeDasharray: L, strokeDashoffset: L * (1 - frac) }} />
        <text x="80" y="80">{Math.ceil(left / 1000)}</text>
      </svg>
      <button className="btn danger big" autoFocus onClick={() => station.send({ cmd: 'payload_abort' })}>{tr('Abortar')} <kbd>{tr('Esc')}</kbd></button>
    </div>
  )
}

/** Aviso rápido depois de cada lançamento. */
export function ReleaseFlash() {
  useChannels('payload')
  const ev = station.lastRelease
  const at = station.lastReleaseAt
  const [expired, setExpired] = useState(0)
  // Some 6 s depois do último lançamento (ou da confirmação dele).
  useEffect(() => {
    if (!at) return
    const id = setTimeout(() => setExpired(at), 6000)
    return () => clearTimeout(id)
  }, [at])
  if (!ev || expired === at) return null
  const conf = ev.confirmed === true ? <span className="ok">{tr('pino confirmado')}</span> : ev.confirmed === false ? <span className="crit">{tr('chave não abriu')}</span> : <span>{tr('sem chave')}</span>
  return (
    <div className="rflash" role="status">
      <b>{tr('Nº {n}', { n: ev.n })}</b> {tr('{name} solto a {alt} m', { name: ev.name, alt: ev.alt_rel.toFixed(1) })} · {conf}
    </div>
  )
}

/** Indicador na barra superior: carregados e contador. Abre o painel na tela de voo. */
export function DeliveryChip() {
  useChannels('payload')
  const p = station.payload
  if (!p) return null
  const enabled = p.slots.filter((s) => s.enabled).length
  return (
    <button className={`pill dchip ${p.armed ? 'armed' : ''} ${p.countdown ? 'count' : ''}`} title={tr('Entrega: {loaded} de {enabled} carregados, {total} lançamentos', { loaded: p.loaded, enabled, total: p.total })}
      onClick={() => { station.deliveryOpen = true; station.setView('fly') }}>
      <Icon.drop />
      <span>{p.loaded}/{enabled}</span>
      <small>nº {p.total}</small>
    </button>
  )
}

// ---------------- Configuração ----------------

function nextFree(slots: PayloadSlot[]): PayloadSlot {
  const id = Math.max(0, ...slots.map((s) => s.id)) + 1
  const usedCh = new Set(slots.flatMap((s) => (s.actuator.type === 'servo' ? [s.actuator.channel] : [])))
  const usedBit = new Set(slots.map((s) => s.switch_bit))
  const ch = SERVO_OUTPUTS.find((c) => !usedCh.has(c)) ?? 16
  const bit = [0, 1, 2, 3, 4, 5].find((b) => !usedBit.has(b)) ?? null
  return { id, name: `ENT${id}`, actuator: { type: 'servo', channel: ch, pwm_locked: 1100, pwm_released: 1900 }, switch_bit: bit, mass_g: 250, enabled: true, loaded: false, releases: 0 }
}

/** Configuração completa da placa: 6 servos com chave e 2 solenoides. */
function boardPreset(): PayloadSlot[] {
  const servos = [5, 6, 7, 8, 10, 11].map((ch, i): PayloadSlot => ({
    id: i + 1, name: `ENT${i + 1}`, actuator: { type: 'servo', channel: ch, pwm_locked: 1100, pwm_released: 1900 },
    switch_bit: i, mass_g: 250, enabled: true, loaded: false, releases: 0,
  }))
  const sols = [2, 3].map((r, i): PayloadSlot => ({
    id: 7 + i, name: `SOL${i + 1}`, actuator: { type: 'relay', relay: r }, switch_bit: null, mass_g: 500, enabled: true, loaded: false, releases: 0,
  }))
  return [...servos, ...sols]
}

function validate(slots: PayloadSlot[]): string | null {
  const ch = new Set<number>(), rl = new Set<number>(), bits = new Set<number>(), names = new Set<string>()
  for (const s of slots) {
    if (!s.name.trim()) return tr('Todo compartimento precisa de nome')
    if (names.has(s.name.trim())) return tr('Nome repetido: {name}', { name: s.name })
    names.add(s.name.trim())
    if (s.actuator.type === 'servo') {
      if (ch.has(s.actuator.channel)) return tr('Saída {channel} usada duas vezes', { channel: s.actuator.channel })
      ch.add(s.actuator.channel)
      if (Math.abs(s.actuator.pwm_locked - s.actuator.pwm_released) < 120) return tr('{name}: PWM travado e solto muito próximos', { name: s.name })
    } else {
      if (rl.has(s.actuator.relay)) return tr('Relé {relay} usado duas vezes', { relay: s.actuator.relay })
      rl.add(s.actuator.relay)
    }
    if (s.switch_bit != null) {
      if (bits.has(s.switch_bit)) return tr('Chave SW{n} usada duas vezes', { n: s.switch_bit + 1 })
      bits.add(s.switch_bit)
    }
  }
  return slots.length > 16 ? tr('No máximo 16 compartimentos') : null
}

function SlotEditor({ s, onChange, onRemove, armed }: { s: PayloadSlot; onChange: (s: PayloadSlot) => void; onRemove: () => void; armed: boolean }) {
  const a = s.actuator
  const n = (v: string, lo: number, hi: number, d: number) => clamp(Number.isFinite(+v) && v !== '' ? +v : d, lo, hi)
  const live = station.payload?.slots.find((x) => x.id === s.id)
  return (
    <div className="slotcfg">
      <div className="sch">
        <input className="nm" value={s.name} maxLength={24} aria-label={tr('Nome do compartimento')} onChange={(e) => onChange({ ...s, name: e.target.value })} />
        <label className="tog"><input type="checkbox" checked={s.enabled} onChange={(e) => onChange({ ...s, enabled: e.target.checked })} />{tr('Ativo')}</label>
        <span className="muted">{live ? tr('{releases} lançamentos', { releases: live.releases }) : 'novo'}</span>
        <button className="ib" aria-label={tr('Remover {name}', { name: s.name })} onClick={onRemove}>✕</button>
      </div>
      <div className="grid4">
        <label>{tr('Atuador')}
          <select value={a.type} onChange={(e) => onChange({ ...s, actuator: e.target.value === 'servo' ? { type: 'servo', channel: 5, pwm_locked: 1100, pwm_released: 1900 } : { type: 'relay', relay: 2 } })}>
            <option value="servo">{tr('Servo (puxa o pino)')}</option>
            <option value="relay">{tr('Solenoide / trava')}</option>
          </select>
        </label>
        {a.type === 'servo' ? (
          <>
            <label>{tr('Saída')}
              <select value={a.channel} onChange={(e) => onChange({ ...s, actuator: { ...a, channel: +e.target.value } })}>
                {SERVO_OUTPUTS.map((c) => <option key={c} value={c}>SERVO{c}{c <= 8 ? ` · ENT${c - 4}` : c === 10 ? ' · ENT5' : c === 11 ? ' · ENT6' : ''}</option>)}
              </select>
            </label>
            <label>{tr('PWM travado (µs)')}<input type="number" min={800} max={2200} step={10} value={a.pwm_locked} onChange={(e) => onChange({ ...s, actuator: { ...a, pwm_locked: n(e.target.value, 800, 2200, 1100) } })} /></label>
            <label>{tr('PWM solto (µs)')}<input type="number" min={800} max={2200} step={10} value={a.pwm_released} onChange={(e) => onChange({ ...s, actuator: { ...a, pwm_released: n(e.target.value, 800, 2200, 1900) } })} /></label>
          </>
        ) : (
          <label>{tr('Relé')}
            <select value={a.relay} onChange={(e) => onChange({ ...s, actuator: { type: 'relay', relay: +e.target.value } })}>
              {RELAYS.map(([r, l]) => <option key={r} value={r}>{l}</option>)}
            </select>
          </label>
        )}
        <label>{tr('Chave de confirmação')}
          <select value={s.switch_bit ?? -1} onChange={(e) => onChange({ ...s, switch_bit: +e.target.value < 0 ? null : +e.target.value })}>
            <option value={-1}>{tr('Nenhuma')}</option>
            {[0, 1, 2, 3, 4, 5].map((b) => <option key={b} value={b}>SW{b + 1}</option>)}
          </select>
        </label>
        <label>{tr('Massa da carga (g)')}<input type="number" min={0} max={20000} step={10} value={s.mass_g} onChange={(e) => onChange({ ...s, mass_g: n(e.target.value, 0, 20000, 0) })} /></label>
      </div>
      {live && (
        <div className="brow">
          <button className="btn" disabled={armed} title={armed ? tr('Só com os motores desarmados') : tr('Solta e trava de novo; não conta no contador')} onClick={() => station.send({ cmd: 'payload_test', slot: s.id })}>{tr('Testar')}</button>
          <button className="btn" onClick={() => station.send({ cmd: 'payload_lock', slot: s.id })}>{tr('Travar')}</button>
          <button className="btn" onClick={() => station.send({ cmd: 'payload_loaded', slot: s.id, loaded: !live.loaded })}>{live.loaded ? tr('Marcar vazio') : tr('Marcar carregado')}</button>
          <span className="hint">{actuatorLabel(live.actuator)} · {live.loaded ? 'carregado' : 'vazio'}{live.pwm ? tr(' · saída em {pwm} µs', { pwm: live.pwm }) : ''}</span>
        </div>
      )}
    </div>
  )
}

export function DeliverySetup() {
  useChannels('payload', 'telemetry')
  const p = station.payload
  const [draft, setDraft] = useState<{ slots: PayloadSlot[]; settings: PayloadSettings } | null>(null)
  const dirty = draft !== null
  const slots = draft?.slots ?? p?.slots ?? []
  const st = draft?.settings ?? p?.settings
  const edit = (patch: Partial<{ slots: PayloadSlot[]; settings: PayloadSettings }>) =>
    setDraft({ slots: patch.slots ?? slots, settings: patch.settings ?? st! })
  const err = validate(slots)
  if (!p || !st) return <><h2>{tr('Entrega')}</h2><p className="desc">{tr('Aguardando a ponte enviar a configuração do sistema de entrega.')}</p></>
  const num = (k: keyof PayloadSettings, label: string, desc: string, lo: number, hi: number, step = 1, unit = '') => (
    <div className="field">
      <label htmlFor={`pl_${k}`}>{label}<small>{desc}</small></label>
      <div className="fin"><input id={`pl_${k}`} type="number" min={lo} max={hi} step={step} value={st[k] as number}
        onChange={(e) => edit({ settings: { ...st, [k]: clamp(+e.target.value || 0, lo, hi) } })} />{unit}</div>
    </div>
  )
  return (
    <>
      <h2>{tr('Entrega')}</h2>
      <p className="desc">{tr('Compartimentos com pino de trava. Cada um tem um servo que puxa o pino (ou um solenoide) e, se quiser, uma chave que confirma que o pino saiu. A configuração fica gravada na ponte, junto com o contador de lançamentos.')}</p>
      <div className="card">
        <h3>{tr('Segurança e contagem')}</h3>
        {num('countdown_s', tr('Contagem regressiva'), tr('segundos antes de soltar; Esc ou Abortar cancela. 0 pede dois cliques'), 0, 10, 1, 's')}
        {num('min_alt_m', tr('Altura mínima'), tr('acima do ponto de decolagem; 0 desliga'), 0, 500, 0.5, 'm')}
        <div className="field">
          <label htmlFor="pl_req">{tr('Só com motores armados')}<small>{tr('impede soltar a carga no chão por engano')}</small></label>
          <div className="fin"><input id="pl_req" type="checkbox" checked={st.require_armed} onChange={(e) => edit({ settings: { ...st, require_armed: e.target.checked } })} /></div>
        </div>
        {num('relock_s', tr('Travar de novo após'), tr('o servo volta para recolocar o pino; 0 = fica solto (solenoide sempre pulsa)'), 0, 30, 0.5, 's')}
        {num('salvo_interval_s', tr('Intervalo da salva'), tr('entre compartimentos quando solta vários'), 0, 10, 0.1, 's')}
        {num('mission_hold_s', tr('Pairar na entrega da missão'), tr('tempo parado sobre o ponto depois de soltar'), 1, 60, 1, 's')}
      </div>
      <div className="card">
        <h3>{tr('Compartimentos ({n})', { n: slots.length })}</h3>
        {slots.map((s, i) => (
          <SlotEditor key={s.id} s={s} armed={!!station.telem?.armed}
            onChange={(x) => edit({ slots: slots.map((y, j) => (j === i ? x : y)) })}
            onRemove={() => edit({ slots: slots.filter((_, j) => j !== i) })} />
        ))}
        <div className="brow" style={{ padding: '12px 0' }}>
          <button className="btn" disabled={slots.length >= 16} onClick={() => edit({ slots: [...slots, nextFree(slots)] })}><Icon.plus />{tr('Adicionar compartimento')}</button>
          <button className="btn" onClick={() => edit({ slots: boardPreset() })}>{tr('Usar placa completa (6 servos + 2 solenoides)')}</button>
        </div>
      </div>
      <div className="brow" style={{ marginTop: 14, alignItems: 'center' }}>
        <button className="btn on" disabled={!dirty || !!err || !!p.countdown} onClick={() => { if (station.send({ cmd: 'payload_config', slots: slots.map((s) => ({ ...s, name: s.name.trim() })), settings: st })) setDraft(null) }}>{tr('Salvar na ponte')}</button>
        <button className="btn" disabled={!dirty} onClick={() => setDraft(null)}>{tr('Descartar')}</button>
        <ConfirmButton label={tr('Zerar contador')} confirmLabel={tr('Confirmar: apagar {total} lançamentos', { total: p.total })} disabled={!p.total || !!p.countdown} onConfirm={() => station.send({ cmd: 'payload_reset_counter' })} />
        {err ? <span className="hint crit">{err}</span> : dirty ? <span className="hint warn">{tr('Alterações não salvas')}</span> : null}
      </div>
      <div className="card">
        <h3>{tr('No ArduPilot')}</h3>
        <div className="hint" style={{ padding: '4px 0 12px' }}>
          {/* Trechos entre crases viram <code>. */}
          {tr('Servos: `SERVOn_FUNCTION = 0` nas saídas usadas (a ponte usa `MAV_CMD_DO_SET_SERVO`). Solenoides: `RELAYn_FUNCTION = 1` e `RELAYn_PIN` (SOL1 = 83, SOL2 = 84). Chaves: copie `entrega.lua` para `APM/scripts` no microSD e ligue `SCR_ENABLE`.')
            .split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
        </div>
      </div>
    </>
  )
}

// ---------------- Histórico ----------------

export function DeliveryLog() {
  useChannels('payload')
  const p = station.payload
  const [csv, setCsv] = useState<string | null>(null)
  const log = p?.log ?? []
  const ok = log.filter((e) => e.confirmed === true).length
  const fail = log.filter((e) => e.confirmed === false).length
  const mass = log.reduce((a, e) => a + e.mass_g, 0)
  const copy = async () => {
    const rows = [...log].reverse().map((e: ReleaseEvent) => [e.n, new Date(e.t).toISOString(), e.name, e.source, e.alt_rel.toFixed(1), e.groundspeed.toFixed(1), e.lat.toFixed(7), e.lon.toFixed(7), e.mass_g, e.confirmed ?? ''].join(','))
    const txt = ['numero,hora,compartimento,origem,altura_m,vel_ms,lat,lon,massa_g,confirmado', ...rows].join('\n')
    try { await navigator.clipboard.writeText(txt); station.addLog('ok', tr('CSV de lançamentos copiado ({length})', { length: log.length })); setCsv(null) } catch { setCsv(txt) }
  }
  return (
    <>
      <h2>{tr('Lançamentos')}</h2>
      <p className="desc">{tr('Contador e histórico do sistema de entrega, guardados pela ponte. Inclui solturas feitas pela missão.')}</p>
      <div className="sumgrid">
        <div className="scard"><h4>{tr('Total')}</h4><b>{p?.total ?? '—'}</b></div>
        <div className="scard"><h4>{tr('Confirmados pela chave')}</h4><b className="ok">{ok}</b></div>
        <div className="scard"><h4>{tr('Chave não abriu')}</h4><b className={fail ? 'crit' : ''}>{fail}</b></div>
        <div className="scard"><h4>{tr('Carga entregue')}</h4><b>{kg(mass)}</b></div>
      </div>
      <div className="brow" style={{ marginTop: 14 }}>
        <button className="btn" disabled={!log.length} onClick={copy}>{tr('Copiar CSV')}</button>
        <button className="btn" disabled={!log.length} onClick={() => { station.setView('fly'); station.mapApi?.fit(log.map((e) => ({ lat: e.lat, lon: e.lon }))) }}>{tr('Ver no mapa')}</button>
      </div>
      {csv && <textarea className="json" readOnly value={csv} autoFocus onFocus={(e) => e.target.select()} aria-label={tr('CSV')} />}
      <div className="tblw">
        <table className="mav">
          <thead><tr><th>{tr('Nº')}</th><th>{tr('Hora')}</th><th>{tr('Compartimento')}</th><th>{tr('Origem')}</th><th>{tr('Altura')}</th><th>{tr('Vel.')}</th><th>{tr('Posição')}</th><th>{tr('Chave')}</th></tr></thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.n}>
                <td>{e.n}</td><td>{clock(e.t)}</td><td>{e.name}</td><td>{e.source}</td>
                <td>{e.alt_rel.toFixed(1)} m</td><td>{e.groundspeed.toFixed(1)} m/s</td>
                <td>{e.lat.toFixed(6)}, {e.lon.toFixed(6)}</td>
                <td className={e.confirmed === true ? 'ok' : e.confirmed === false ? 'crit' : ''}>{e.confirmed === true ? 'confirmado' : e.confirmed === false ? tr('não abriu') : '—'}</td>
              </tr>
            ))}
            {!log.length && <tr><td colSpan={8} className="empty">{tr('Nenhum lançamento registrado.')}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ---------------- Plano de missão ----------------

/** Escolha dos compartimentos soltos num waypoint. */
export function DropPicker({ index }: { index: number }) {
  useChannels('payload', 'mission')
  const w = station.plan[index]
  const slots = station.payload?.slots.filter((s) => s.enabled) ?? []
  if (!w || !slots.length) return null
  // Um compartimento só pode ser solto uma vez na missão.
  const usedElsewhere = new Set(station.plan.flatMap((x, j) => (j === index ? [] : x.drop ?? [])))
  const cur = w.drop ?? []
  const toggle = (id: number) => {
    const drop = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    station.setPlan(station.plan.map((x, j) => (j === index ? { ...x, drop } : x)))
  }
  return (
    <div className="droppick" onClick={(e) => e.stopPropagation()}>
      <span><Icon.drop />{tr('Soltar aqui')}</span>
      {slots.map((s) => (
        <button key={s.id} className={`chip ${cur.includes(s.id) ? 'on' : ''}`} disabled={usedElsewhere.has(s.id)}
          title={usedElsewhere.has(s.id) ? tr('Já usado em outro ponto') : actuatorLabel(s.actuator)} onClick={() => toggle(s.id)}>{s.name}</button>
      ))}
    </div>
  )
}
