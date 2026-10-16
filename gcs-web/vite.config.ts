import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { host: true },
  worker: { format: 'es' },
  // O MapLibre sozinho passa de 1 MB; não é problema para uma estação de solo.
  build: { chunkSizeWarningLimit: 1600 },
})
