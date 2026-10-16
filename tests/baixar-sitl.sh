#!/usr/bin/env bash
# Baixa o SITL oficial do ArduPilot (versão estável, Linux x86-64) para os testes.
#   tests/baixar-sitl.sh [pasta]   (padrão: tests/.sitl)
set -euo pipefail
DIR="${1:-$(dirname "$(readlink -f "$0")")/.sitl}"
mkdir -p "$DIR"
FW=https://firmware.ardupilot.org
RAW=https://raw.githubusercontent.com/ArduPilot/ardupilot/master/Tools/autotest
curl -sfL -o "$DIR/arducopter" "$FW/Copter/stable/SITL_x86_64_linux_gnu/arducopter"
curl -sfL -o "$DIR/arduplane" "$FW/Plane/stable/SITL_x86_64_linux_gnu/arduplane"
curl -sfL -o "$DIR/copter.parm" "$RAW/default_params/copter.parm"
curl -sfL -o "$DIR/plane.parm" "$RAW/models/plane.parm"
chmod +x "$DIR/arducopter" "$DIR/arduplane"
echo "SITL em $DIR ($(curl -sfL "$FW/Copter/stable/SITL_x86_64_linux_gnu/firmware-version.txt"))"
