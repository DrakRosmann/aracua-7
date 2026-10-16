#!/usr/bin/env bash
# Importa símbolos, footprints e modelos 3D das peças do FC Aracuã-7 a partir do LCSC/EasyEDA
# para uma biblioteca do projeto KiCad.
#
# Uso:  ./importar_pecas.sh <pasta-do-projeto-kicad> [pecas_lcsc.csv]
# Gera: <projeto>/libs/Aracua7.kicad_sym, Aracua7.pretty/ e Aracua7.3dshapes/
set -euo pipefail

PROJ="${1:?informe a pasta do projeto KiCad (onde fica o .kicad_pro)}"
CSV="${2:-$(dirname "$(readlink -f "$0")")/pecas_lcsc.csv}"
PROJ="$(readlink -f "$PROJ")"
CSV="$(readlink -f "$CSV")"

[ -f "$CSV" ] || { echo "CSV não encontrado: $CSV"; exit 1; }
ls "$PROJ"/*.kicad_pro >/dev/null 2>&1 || echo "Aviso: nenhum .kicad_pro em $PROJ (crie o projeto no KiCad primeiro)."

# Ambiente Python isolado, para não mexer no Python do sistema
VENV="$HOME/.local/share/easyeda2kicad-venv"
if [ ! -x "$VENV/bin/easyeda2kicad" ]; then
  echo ">> Instalando easyeda2kicad em $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip easyeda2kicad
fi
E2K="$VENV/bin/easyeda2kicad"

mkdir -p "$PROJ/libs"
cd "$PROJ"   # --project-relative grava os caminhos 3D como ${KIPRJMOD}/libs/...

ok=0; falhou=()
# Colunas: ref,qtd,peca,lcsc,origem  — importa só as linhas com origem "easyeda" e código LCSC
while IFS=, read -r ref qtd peca lcsc origem; do
  [ "$ref" = "ref" ] && continue
  [ "$origem" = "easyeda" ] && [ -n "$lcsc" ] || continue
  echo ">> $ref  $peca  ($lcsc)"
  if "$E2K" --full --lcsc_id "$lcsc" --output "libs/Aracua7" --project-relative --overwrite \
        --custom-field "LCSC:$lcsc" >/dev/null 2>"/tmp/e2k_$lcsc.log"; then
    ok=$((ok+1))
  else
    falhou+=("$ref $peca $lcsc")
  fi
  sleep 1   # não sobrecarregar a API do EasyEDA
done < "$CSV"

echo
echo "Importadas: $ok peças em $PROJ/libs/"
ls -1 libs | sed 's/^/   /'
if [ ${#falhou[@]} -gt 0 ]; then
  echo "Falharam (veja /tmp/e2k_<codigo>.log e tente de novo):"
  printf '   %s\n' "${falhou[@]}"
fi

cat <<'FIM'

Próximo passo no KiCad (com o projeto aberto):
  Preferências > Gerenciar bibliotecas de símbolos > aba "Biblioteca do projeto" > +
     Apelido: Aracua7    Caminho: ${KIPRJMOD}/libs/Aracua7.kicad_sym
  Preferências > Gerenciar bibliotecas de footprints > aba "Biblioteca do projeto" > +
     Apelido: Aracua7    Caminho: ${KIPRJMOD}/libs/Aracua7.pretty
FIM
