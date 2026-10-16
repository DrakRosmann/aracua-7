// Compila a ponte e o veículo simulado e copia para src-tauri/binaries/ com o
// sufixo do alvo que o Tauri espera (ex.: aracua-bridge-x86_64-unknown-linux-gnu).
// Alvo: TAURI_ENV_TARGET_TRIPLE (definido pelo `tauri build --target`) ou o do host.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = join(here, '..', '..', 'bridge')
const out = join(here, '..', 'src-tauri', 'binaries')

const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/host: (\S+)/)[1]
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host
const ext = target.includes('windows') ? '.exe' : ''
const args = ['build', '--release', '--bins', '--manifest-path', join(bridge, 'Cargo.toml')]
if (target !== host) args.push('--target', target)

console.log(`== ponte e simulador para ${target}`)
execFileSync('cargo', args, { stdio: 'inherit' })
mkdirSync(out, { recursive: true })
const built = join(bridge, 'target', target !== host ? target : '', 'release')
for (const name of ['aracua-bridge', 'fake-vehicle']) {
  copyFileSync(join(built, name + ext), join(out, `${name}-${target}${ext}`))
}
console.log(`== copiados para ${out}`)
