# Quadros de referência

Quadros binários do mapa (ver [`../protocolo.md`](../protocolo.md)) usados nos testes das três
implementações. Se algum lado mudar o formato, os testes dos outros quebram.

| Arquivo | Conteúdo |
|---|---|
| `avx1_exemplo.bin` | `AVX1`, reset ligado, origem −23.55052, −46.63331, 760 m, voxel 0,5 m, 3 voxels: `(−3, 7, 12, obstáculo, 200)`, `(100, −250, 0, solo, 9)`, `(32767, −32768, −1, obstáculo, 255)` |
| `aob1_exemplo.bin` | `AOB1`, 72 setores de 5°, alcance 40 m; setor 0 = 150 cm, setor 18 = 420 cm, setor 71 = 4001 cm (livre: alcance + 1 cm), os demais `0xFFFF` |

Conferidos por `bridge/src/mapframe.rs`, `ros2_ws/src/aracua_onboard/test/test_core.cpp` e
`gcs-web/src/lib/mapframe.test.ts`.
