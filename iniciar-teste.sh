#!/usr/bin/env bash
# Aracuã-7: sobe a ponte, o veículo simulado e a interface (Linux/macOS).
# Requer Rust (rustup) e Node.js 20.19+ ou 22.12+. Ctrl+C encerra tudo.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

command -v cargo >/dev/null || { echo "[erro] cargo não encontrado. Instale o Rust: https://rustup.rs"; exit 1; }
command -v npm >/dev/null || { echo "[erro] npm não encontrado. Instale o Node.js LTS: https://nodejs.org"; exit 1; }

echo "== Compilando a ponte e o veículo simulado (a primeira vez demora alguns minutos)"
(cd bridge && cargo build --release --bins)
echo "== Instalando dependências da interface"
(cd gcs-web && { [ -d node_modules ] || npm ci; })

pids=()
trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
bridge/target/release/aracua-bridge & pids+=($!)
sleep 1
bridge/target/release/fake-vehicle & pids+=($!)
(cd gcs-web && npm run dev -- --open) & pids+=($!)
echo "Pronto: http://localhost:5173 — Ctrl+C encerra."
wait
