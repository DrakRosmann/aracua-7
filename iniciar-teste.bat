@echo off
rem Aracua-7: sobe a ponte, o veiculo simulado e a interface no Windows.
rem Requer Rust (rustup) e Node.js 20.19+ ou 22.12+ no PATH.
cd /d "%~dp0"

where cargo >nul 2>nul || (echo [erro] cargo nao encontrado. Instale o Rust em https://rustup.rs & pause & exit /b 1)
where npm >nul 2>nul || (echo [erro] npm nao encontrado. Instale o Node.js LTS em https://nodejs.org & pause & exit /b 1)

echo == Compilando a ponte e o veiculo simulado (a primeira vez demora alguns minutos)
pushd bridge
cargo build --release --bins || (popd & pause & exit /b 1)
popd

echo == Instalando dependencias da interface
pushd gcs-web
if not exist node_modules call npm install || (popd & pause & exit /b 1)
popd

start "Aracua - ponte" cmd /k "bridge\target\release\aracua-bridge.exe"
timeout /t 2 /nobreak >nul
start "Aracua - veiculo simulado" cmd /k "bridge\target\release\fake-vehicle.exe"
start "Aracua - interface" cmd /k "cd gcs-web && npm run dev"
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
echo Pronto. Feche as tres janelas para encerrar.
