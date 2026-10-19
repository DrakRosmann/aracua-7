// Imagem da câmera (MJPEG, HLS ou MP4), usada no quadro da tela de voo e na aba Painel.

import { useState } from 'react'
import { station, useChannels } from '../lib/store'
import { t as tr } from '../lib/i18n'

export function CameraFeed() {
  useChannels('ui')
  useChannels('link')
  // Sem vídeo configurado, usa o da câmera do simulador (app desktop).
  const url = station.settings.videoUrl || station.link?.camera_url || ''
  // Erro vale só para a URL que falhou; trocar o endereço tenta de novo.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const err = failedUrl === url
  const setErr = () => setFailedUrl(url)
  const isVideo = /\.(m3u8|mp4|webm)(\?|$)/i.test(url)
  if (url && !err) return isVideo ? <video src={url} autoPlay muted playsInline onError={setErr} /> : <img src={url} alt={tr('Vídeo da câmera')} onError={setErr} />
  return <span className="novideo">{url ? tr('Sem sinal de vídeo') : tr('Sem vídeo configurado')}</span>
}
