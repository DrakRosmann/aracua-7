#pragma once
// Mapa de voxels esparso: guarda cada célula ocupada uma única vez e informa
// quais são novas, para que só as novidades sigam pelo rádio.

#include <cmath>
#include <cstdint>
#include <unordered_set>
#include <vector>

namespace aracua {

struct Voxel {
  int16_t e, n, u;   // índices em voxels no referencial ENU do mapa
  uint8_t cls;       // 0 = solo, 1 = obstáculo
  uint8_t intensity;
};

class VoxelMap {
 public:
  explicit VoxelMap(double voxel_m = 1.0, double ground_below_m = 0.4, size_t max_voxels = 2'000'000)
      : res_(voxel_m), ground_below_(ground_below_m), max_(max_voxels) {}

  double resolution() const { return res_; }
  size_t size() const { return cells_.size(); }
  bool full() const { return cells_.size() >= max_; }
  void clear() { cells_.clear(); }

  /// Insere um ponto (metros, ENU). Retorna true e preenche `out` se a célula é nova.
  bool insert(double e, double n, double u, uint8_t intensity, Voxel& out) {
    if (!std::isfinite(e) || !std::isfinite(n) || !std::isfinite(u)) return false;
    const double lim = 32767.0 * res_;
    if (std::fabs(e) > lim || std::fabs(n) > lim || std::fabs(u) > lim) return false;
    if (full()) return false;
    const auto ie = static_cast<int16_t>(std::lround(e / res_));
    const auto in = static_cast<int16_t>(std::lround(n / res_));
    const auto iu = static_cast<int16_t>(std::lround(u / res_));
    if (!cells_.insert(key(ie, in, iu)).second) return false;
    out = Voxel{ie, in, iu, static_cast<uint8_t>(u < ground_below_ ? 0 : 1), intensity};
    return true;
  }

  static uint64_t key(int16_t e, int16_t n, int16_t u) {
    return (static_cast<uint64_t>(static_cast<uint16_t>(e)) << 32) |
           (static_cast<uint64_t>(static_cast<uint16_t>(n)) << 16) |
           static_cast<uint64_t>(static_cast<uint16_t>(u));
  }

 private:
  double res_, ground_below_;
  size_t max_;
  std::unordered_set<uint64_t> cells_;
};

}  // namespace aracua
