import { useEffect } from 'react'
import { station, useChannels } from './lib/store'
import { MapView } from './components/MapView'
import { TopBar } from './components/TopBar'
import { FlyView } from './views/FlyView'
import { PlanView } from './views/PlanView'
import { SetupView } from './views/SetupView'
import { AnalyzeView } from './views/AnalyzeView'
import { CockpitView } from './components/Cockpit'
import { Toast } from './views/FlyView'
import { ConnectDialog } from './components/ConnectDialog'
import { isDesktop } from './lib/desktop'
import { t as tr } from './lib/i18n'

function ConnectionBanner() {
  useChannels('conn', 'telemetry', 'link')
  if (station.conn === 'open' && station.telem?.connected) return null
  if (isDesktop) {
    const msg = !station.link?.running ? tr('Sem conexão com o veículo.') : station.conn !== 'open' ? tr('Iniciando a ponte…') : tr('Aguardando HEARTBEAT do veículo.')
    return (
      <div className="banner" role="status">
        {msg} <button className="btn" onClick={() => station.openLinkDialog()}>{tr('Conectar…')}</button>
      </div>
    )
  }
  const msg =
    station.conn !== 'open'
      ? tr('Sem conexão com a ponte em {bridgeUrl}. Rode o aracua-bridge ou ajuste o endereço no menu Aracuã-7.', { bridgeUrl: station.settings.bridgeUrl })
      : tr('Ponte conectada, aguardando HEARTBEAT do veículo.')
  return <div className="banner" role="status">{msg}</div>
}

function DesktopLink() {
  useChannels('link')
  return station.linkDialog ? <ConnectDialog /> : null
}

export default function App() {
  useChannels('ui')
  useEffect(() => {
    if (isDesktop) station.initDesktop()
    else station.connect()
    station.startPad()
  }, [])
  const v = station.view
  return (
    <div id="app">
      <MapView />
      <TopBar />
      {v === 'fly' && <FlyView />}
      {v === 'plan' && <PlanView />}
      {v === 'setup' && <SetupView />}
      {v === 'analyze' && <AnalyzeView />}
      {v === 'panel' && <><CockpitView /><Toast /></>}
      {(v === 'fly' || v === 'plan' || v === 'panel') && <ConnectionBanner />}
      {isDesktop && <DesktopLink />}
    </div>
  )
}
