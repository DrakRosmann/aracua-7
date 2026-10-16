// Tela "Conectar" do app desktop: simulador, rádio de telemetria (serial),
// UDP ou TCP. A escolha fica salva e é usada de novo ao abrir o app.

import { useEffect, useRef, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { desktop, savedLink, type LinkConfig, type PortInfo } from '../lib/desktop'

type Kind = LinkConfig['kind']

const KINDS: { kind: Kind; title: string; text: string }[] = [
  { kind: 'simulator', title: 'Simulador', text: 'Drone virtual com mapa LiDAR sintético, para treinar e testar sem hardware.' },
  { kind: 'serial', title: 'Rádio de telemetria', text: 'Rádio 915 MHz/433 MHz ou cabo USB direto na controladora.' },
  { kind: 'udp', title: 'Rede (UDP)', text: 'Rádio IP, MAVLink router ou SITL enviando para esta máquina.' },
  { kind: 'tcp', title: 'TCP / SITL', text: 'Conecta num servidor MAVLink TCP, como o SITL do ArduPilot.' },
]

const BAUDS = [57600, 115200, 230400, 460800, 921600, 1500000]

export function ConnectDialog() {
  useChannels('link')
  const last = savedLink()
  const [kind, setKind] = useState<Kind>(last?.kind ?? 'simulator')
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  const [port, setPort] = useState(last?.kind === 'serial' ? last.port : '')
  const [baud, setBaud] = useState(last?.kind === 'serial' ? last.baud : 57600)
  const [listen, setListen] = useState(last?.kind === 'udp' ? last.listen : '0.0.0.0:14550')
  const [address, setAddress] = useState(last?.kind === 'tcp' ? last.address : '127.0.0.1:5760')
  const [showLog, setShowLog] = useState(false)
  const logBox = useRef<HTMLPreElement>(null)

  const scan = () => {
    desktop.serialPorts().then((p) => {
      setPorts(p)
      setPort((cur) => cur || p[0]?.name || '')
    }).catch(() => setPorts([]))
  }
  useEffect(scan, [])
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  })

  const config = (): LinkConfig => {
    switch (kind) {
      case 'simulator': return { kind }
      case 'serial': return { kind, port, baud }
      case 'udp': return { kind, listen }
      case 'tcp': return { kind, address }
    }
  }
  const valid = kind !== 'serial' || port.trim() !== ''
  const running = !!station.link?.running
  const log = station.link?.log ?? []

  return (
    <div className="cx-back" role="dialog" aria-modal="true" aria-labelledby="cx-title">
      <form className="cx" onSubmit={(e) => { e.preventDefault(); if (valid) station.startLink(config()) }}>
        <h2 id="cx-title">Conectar ao Aracuã-7</h2>
        <div className="cx-kinds" role="radiogroup" aria-label="Tipo de conexão">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind}
              className={`cx-kind ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(k.kind)}>
              <b>{k.title}</b>
              <span>{k.text}</span>
            </button>
          ))}
        </div>

        <div className="cx-fields">
          {kind === 'simulator' && (
            <p className="hint">O simulador decola, segue missões, solta cargas e gera um bairro sintético para o LiDAR.
              A física é simplificada: para validar voo de verdade, use o SITL do ArduPilot (opção TCP).</p>
          )}
          {kind === 'serial' && (
            <>
              <label className="field-inline">Porta
                <div className="cx-row">
                  <select value={port} onChange={(e) => setPort(e.target.value)} aria-label="Porta serial">
                    {!ports && <option value="">procurando…</option>}
                    {ports?.length === 0 && <option value="">nenhuma porta encontrada</option>}
                    {port && !ports?.some((p) => p.name === port) && <option value={port}>{port}</option>}
                    {ports?.map((p) => <option key={p.name} value={p.name}>{p.name}{p.description ? ` — ${p.description}` : ''}</option>)}
                  </select>
                  <button type="button" className="btn" onClick={scan}>Procurar de novo</button>
                </div>
              </label>
              <label className="field-inline">Velocidade (baud)
                <select value={baud} onChange={(e) => setBaud(+e.target.value)}>
                  {BAUDS.map((b) => <option key={b} value={b}>{b}{b === 57600 ? ' — rádios SiK' : b === 115200 ? ' — USB da controladora' : ''}</option>)}
                </select>
              </label>
              <p className="hint">No Linux, se a porta não abrir, adicione seu usuário ao grupo <code>dialout</code> e entre de novo na sessão.</p>
            </>
          )}
          {kind === 'udp' && (
            <label className="field-inline">Escutar em
              <input value={listen} onChange={(e) => setListen(e.target.value)} placeholder="0.0.0.0:14550" />
            </label>
          )}
          {kind === 'tcp' && (
            <label className="field-inline">Endereço
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="127.0.0.1:5760" />
            </label>
          )}
        </div>

        {station.linkError && <div className="cx-err" role="alert">{station.linkError}</div>}

        <div className="cx-foot">
          <button type="button" className="btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Esconder log' : 'Ver log da ponte'}</button>
          <span className="sp" />
          {running && <button type="button" className="btn" onClick={() => station.closeLinkDialog()}>Continuar conectado</button>}
          <button type="submit" className="btn on" autoFocus disabled={!valid || station.linkBusy}>{station.linkBusy ? 'Conectando…' : 'Conectar'}</button>
        </div>
        {showLog && <pre className="cx-log" ref={logBox}>{log.length ? log.join('\n') : 'Sem mensagens ainda.'}</pre>}
      </form>
    </div>
  )
}
