// Mapa offline: baixar a área visível antes de ir a campo, ver o tamanho e limpar.

import { useEffect, useRef, useState } from 'react'
import { station, useChannels } from '../lib/store'
import { cacheStats, clearCache, countTiles, downloadArea, MAX_DOWNLOAD_TILES } from '../lib/tiles'
import { t } from '../lib/i18n'

const mb = (b: number) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`

export function OfflineMap() {
  useChannels('ui')
  const [stats, setStats] = useState<{ tiles: number; bytes: number } | null>(null)
  const [extra, setExtra] = useState(3)
  const [prog, setProg] = useState<{ done: number; total: number; failed: number } | null>(null)
  const [msg, setMsg] = useState('')
  const abort = useRef<AbortController | null>(null)
  const refresh = () => void cacheStats().then(setStats)
  useEffect(() => {
    refresh()
    return () => abort.current?.abort()
  }, [])

  const area = station.mapApi?.bounds()
  const z0 = Math.max(1, Math.floor(station.mapApi?.zoom() ?? 15) - 2)
  const z1 = Math.min(19, z0 + 2 + extra)
  const n = area ? countTiles(area, z0, z1) : 0
  const tooMany = n > MAX_DOWNLOAD_TILES

  const start = async () => {
    if (!area) return
    abort.current = new AbortController()
    setMsg('')
    setProg({ done: 0, total: n, failed: 0 })
    try {
      const r = await downloadArea(area, z0, z1, (done, total, failed) => setProg({ done, total, failed }), abort.current.signal)
      setMsg(abort.current.signal.aborted ? t('Download interrompido.') : r.failed ? t('{n} tiles não vieram (sem rede ou fora da cobertura).', { n: r.failed }) : t('Área guardada: o mapa funciona sem internet aqui.'))
    } catch (e) {
      setMsg(String(e))
    } finally {
      setProg(null)
      refresh()
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}><h3>{t('Mapa offline')}</h3>
      <p className="desc">{t('Os tiles vistos com internet ficam guardados neste computador. Para voar sem rede, enquadre a área no mapa e baixe antes de sair.')}</p>
      <div className="field">
        <label htmlFor="st_keep">{t('Guardar o mapa visto')}<small>{t('usa o espaço do navegador')}</small></label>
        <div className="fin"><input id="st_keep" type="checkbox" checked={station.settings.keepTiles} onChange={(e) => station.saveSettings({ keepTiles: e.target.checked })} /></div>
      </div>
      <div className="field">
        <label htmlFor="st_zoom">{t('Detalhe')}<small>{t('zoom {a} a {b} da área visível', { a: z0, b: z1 })}</small></label>
        <div className="fin">
          <select id="st_zoom" value={extra} onChange={(e) => setExtra(+e.target.value)} disabled={!!prog}>
            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{t('+{n} níveis', { n: v })}</option>)}
          </select>
        </div>
      </div>
      <div className="kv"><span>{t('Guardado')}</span><b>{stats ? t('{n} tiles · {mb} no navegador', { n: stats.tiles, mb: mb(stats.bytes) }) : '—'}</b></div>
      {prog && (
        <div className="calbar"><span>{t('Baixando')}</span><i><b style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></i><small>{prog.done}/{prog.total}</small></div>
      )}
      <div className="brow">
        {!prog
          ? <button className="btn on" disabled={!area || tooMany} onClick={start}>{t('Baixar área visível ({n} tiles)', { n })}</button>
          : <button className="btn danger" onClick={() => abort.current?.abort()}>{t('Parar')}</button>}
        <button className="btn" disabled={!!prog || !stats?.tiles} onClick={() => void clearCache().then(refresh)}>{t('Apagar mapa guardado')}</button>
      </div>
      {tooMany && <div className="hint warn">{t('Área grande demais (máximo {max} tiles por vez): aproxime o mapa ou reduza o detalhe.', { max: MAX_DOWNLOAD_TILES })}</div>}
      {msg && <div className="hint">{msg}</div>}
      <p className="desc">{t('Respeite os termos do servidor de tiles: o OpenStreetMap proíbe download em massa, e as imagens da Esri são para uso pessoal e não comercial sem licença ArcGIS. Baixe só a área do voo.')}</p>
    </div>
  )
}
