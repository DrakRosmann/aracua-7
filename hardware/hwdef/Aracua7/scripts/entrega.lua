-- entrega.lua — Aracuã-7
-- Lê as chaves de confirmação dos compartimentos de entrega e envia à estação de solo
-- uma máscara de bits em NAMED_VALUE_FLOAT "ENT_SW" (bit n = compartimento n+1 com pino travado).
-- Copie para APM/scripts/ no cartão microSD. Requer SCR_ENABLE = 1.

local PINOS = {101, 102, 103, 104, 105, 106}   -- GPIO(101..106) do hwdef: PF0, PF1, PF2, PF3, PF10, PF11
local PERIODO_MS = 200                          -- 5 Hz

for _, p in ipairs(PINOS) do
  gpio:pinMode(p, 0)                            -- entrada (o pull-up já vem do hwdef)
end

local function update()
  local mask = 0
  for i, p in ipairs(PINOS) do
    -- chave fechada para GND = nível baixo = pino travado
    if not gpio:read(p) then
      mask = mask | (1 << (i - 1))
    end
  end
  gcs:send_named_float('ENT_SW', mask)
  return update, PERIODO_MS
end

gcs:send_text(6, 'entrega.lua: lendo 6 chaves de compartimento')
return update, 1000
