// Tela "Conectar" do app desktop: simulador, rádio de telemetria (serial),
// UDP, TCP ou reprodução de um voo gravado. A escolha fica salva e é usada de
// novo ao abrir o app (menos a reprodução, que é sempre escolhida na hora).

import { useEffect, useRef, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { desktop, savedLink, SIM_PROPULSION, SIM_VEHICLES, type FlightLog, type LinkConfig, type PortInfo, type SimPropulsion, type SimVehicle } from '../lib/desktop'
import { getLang, t as tr } from '../lib/i18n'

type Kind = LinkConfig['kind']

const KINDS: { kind: Kind; title: string; text: string }[] = [
  { kind: 'simulator', title: tr('Simulador'), text: tr('Drone virtual com mapa LiDAR sintético, para treinar e testar sem hardware.') },
  { kind: 'serial', title: tr('Rádio de telemetria'), text: tr('Rádio 915 MHz/433 MHz ou cabo USB direto na controladora.') },
  { kind: 'udp', title: tr('Rede (UDP)'), text: tr('Rádio IP, MAVLink router ou SITL enviando para esta máquina.') },
  { kind: 'tcp', title: 'TCP / SITL', text: tr('Conecta num servidor MAVLink TCP, como o SITL do ArduPilot.') },
  { kind: 'replay', title: tr('Reproduzir voo'), text: tr('Revê um voo gravado: mapa, instrumentos e mensagens, sem comandar nada.') },
]

const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`)
const when = (s: number) => new Date(s * 1000).toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })

const SIM_HINT: Record<SimVehicle, string> = {
  copter: tr('Multirrotor (ArduCopter): decola na vertical, paira e para no ar.'),
  heli: tr('Helicóptero (ArduCopter TradHeli): mesmos modos do multirrotor.'),
  plane: tr('Avião (ArduPlane): decola correndo no modo TAKEOFF, voa a ~18 m/s e circula para "parar"; LOITER e RTL circulam.'),
  vtol: tr('VTOL (ArduPlane QuadPlane): decola na vertical, voa como avião e pousa na vertical nos modos Q (QLAND, QRTL).'),
}

const BAUDS = [57600, 115200, 230400, 460800, 921600, 1500000]

export function ConnectDialog() {
  useChannels('link')
  const last = savedLink()
  const [kind, setKind] = useState<Kind>(last?.kind && last.kind !== 'replay' ? last.kind : 'simulator')
  const [logs, setLogs] = useState<FlightLog[] | null>(null)
  const [file, setFile] = useState('')
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  const [port, setPort] = useState(last?.kind === 'serial' ? last.port : '')
  const [baud, setBaud] = useState(last?.kind === 'serial' ? last.baud : 57600)
  const [listen, setListen] = useState(last?.kind === 'udp' ? last.listen : '0.0.0.0:14550')
  const [address, setAddress] = useState(last?.kind === 'tcp' ? last.address : '127.0.0.1:5760')
  const [vehicle, setVehicle] = useState<SimVehicle>(last?.kind === 'simulator' ? last.vehicle ?? 'copter' : 'copter')
  const [propulsion, setPropulsion] = useState<SimPropulsion>(last?.kind === 'simulator' ? last.propulsion ?? 'electric' : 'electric')
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
    if (kind !== 'replay' || logs) return
    desktop.logs().then((l) => { setLogs(l); setFile((f) => f || l[0]?.path || '') }).catch(() => setLogs([]))
  }, [kind, logs])
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  })

  const config = (): LinkConfig => {
    switch (kind) {
      case 'simulator': return { kind, vehicle, propulsion }
      case 'serial': return { kind, port, baud }
      case 'udp': return { kind, listen }
      case 'tcp': return { kind, address }
      case 'replay': return { kind, file }
    }
  }
  const valid = kind === 'serial' ? port.trim() !== '' : kind === 'replay' ? file !== '' : true
  const running = !!station.link?.running
  const log = station.link?.log ?? []

  return (
    <div className="cx-back" role="dialog" aria-modal="true" aria-labelledby="cx-title">
      <form className="cx" onSubmit={(e) => { e.preventDefault(); if (valid) station.startLink(config()) }}>
        <h2 id="cx-title">{tr('Conectar ao Aracuã-7')}</h2>
        <div className="cx-kinds" role="radiogroup" aria-label={tr('Tipo de conexão')}>
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
            <>
              <div className="cx-seg" role="radiogroup" aria-label={tr('Tipo de veículo simulado')}>
                {SIM_VEHICLES.map((v) => (
                  <button key={v.id} type="button" role="radio" aria-checked={vehicle === v.id}
                    className={vehicle === v.id ? 'on' : ''} onClick={() => setVehicle(v.id)}>{tr(v.label)}</button>
                ))}
              </div>
              <div className="cx-seg" role="radiogroup" aria-label={tr('Motor do veículo simulado')}>
                {SIM_PROPULSION.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={propulsion === p.id}
                    className={propulsion === p.id ? 'on' : ''} onClick={() => setPropulsion(p.id)}>{tr(p.label)}</button>
                ))}
              </div>
              <p className="hint">{SIM_HINT[vehicle]} {tr('O simulador segue missões, solta cargas e gera um bairro sintético para o LiDAR. A física é simplificada: para validar voo de verdade, use o SITL do ArduPilot (opção TCP).')}</p>
            </>
          )}
          {kind === 'serial' && (
            <>
              <label className="field-inline">{tr('Porta')}
                <div className="cx-row">
                  <select value={port} onChange={(e) => setPort(e.target.value)} aria-label={tr('Porta serial')}>
                    {!ports && <option value="">{tr('procurando…')}</option>}
                    {ports?.length === 0 && <option value="">{tr('nenhuma porta encontrada')}</option>}
                    {port && !ports?.some((p) => p.name === port) && <option value={port}>{port}</option>}
                    {ports?.map((p) => <option key={p.name} value={p.name}>{p.name}{p.description ? ` — ${p.description}` : ''}</option>)}
                  </select>
                  <button type="button" className="btn" onClick={scan}>{tr('Procurar de novo')}</button>
                </div>
              </label>
              <label className="field-inline">{tr('Velocidade (baud)')}
                <select value={baud} onChange={(e) => setBaud(+e.target.value)}>
                  {BAUDS.map((b) => <option key={b} value={b}>{b}{b === 57600 ? tr(' — rádios SiK') : b === 115200 ? tr(' — USB da controladora') : ''}</option>)}
                </select>
              </label>
              <p className="hint">{tr('No Linux, se a porta não abrir, adicione seu usuário ao grupo `dialout` e entre de novo na sessão.').split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</p>
            </>
          )}
          {kind === 'udp' && (
            <label className="field-inline">{tr('Escutar em')}
              <input value={listen} onChange={(e) => setListen(e.target.value)} placeholder="0.0.0.0:14550" />
            </label>
          )}
          {kind === 'tcp' && (
            <label className="field-inline">{tr('Endereço')}
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="127.0.0.1:5760" />
            </label>
          )}
          {kind === 'replay' && (
            <>
              <label className="field-inline">{tr('Voo gravado')}
                <select value={file} onChange={(e) => setFile(e.target.value)}>
                  {!logs && <option value="">{tr('procurando…')}</option>}
                  {logs?.length === 0 && <option value="">{tr('nenhum voo gravado ainda')}</option>}
                  {logs?.map((l) => <option key={l.path} value={l.path}>{when(l.modified)} · {size(l.bytes)}</option>)}
                </select>
              </label>
              <p className="hint">{tr('Toda conexão com veículo é gravada (formato .tlog, o mesmo do Mission Planner e do QGroundControl). Na reprodução dá para pausar, acelerar e pular.')}</p>
            </>
          )}
        </div>

        {station.linkError && <div className="cx-err" role="alert">{station.linkError}</div>}

        <div className="cx-foot">
          <button type="button" className="btn" onClick={() => setShowLog(!showLog)}>{showLog ? tr('Esconder log') : tr('Ver log da ponte')}</button>
          <span className="sp" />
          {running && <button type="button" className="btn" onClick={() => station.closeLinkDialog()}>{tr('Continuar conectado')}</button>}
          <button type="submit" className="btn on" autoFocus disabled={!valid || station.linkBusy}>{station.linkBusy ? tr('Conectando…') : kind === 'replay' ? tr('Reproduzir') : tr('Conectar')}</button>
        </div>
        {showLog && <pre className="cx-log" ref={logBox}>{log.length ? log.join('\n') : tr('Sem mensagens ainda.')}</pre>}
      </form>
    </div>
  )
}
