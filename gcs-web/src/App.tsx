import { useEffect } from 'react'
import { station, useChannels } from './lib/store'
import { MapView } from './components/MapView'
import { TopBar } from './components/TopBar'
import { FlyView } from './views/FlyView'
import { PlanView } from './views/PlanView'
import { SetupView } from './views/SetupView'
import { AnalyzeView } from './views/AnalyzeView'

function ConnectionBanner() {
  useChannels('conn', 'telemetry')
  if (station.conn === 'open' && station.telem?.connected) return null
  const msg =
    station.conn !== 'open'
      ? `Sem conexão com a ponte em ${station.settings.bridgeUrl}. Rode o aracua-bridge ou ajuste o endereço no menu Aracuã-7.`
      : 'Ponte conectada, aguardando HEARTBEAT do veículo.'
  return <div className="banner" role="status">{msg}</div>
}

export default function App() {
  useChannels('ui')
  useEffect(() => {
    station.connect()
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
      {(v === 'fly' || v === 'plan') && <ConnectionBanner />}
    </div>
  )
}
