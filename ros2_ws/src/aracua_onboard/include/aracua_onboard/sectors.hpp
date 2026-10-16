#pragma once
// Distância ao obstáculo mais próximo por setor horizontal, no formato do
// OBSTACLE_DISTANCE do MAVLink: setor 0 na proa, sentido horário.

#include <cmath>
#include <cstdint>
#include <algorithm>
#include <limits>
#include <vector>

#include "aracua_onboard/map_frame.hpp"

namespace aracua {

struct SectorConfig {
  int count = 72;              // 72 setores de 5°
  double min_range_m = 0.6;    // ignora a própria estrutura do drone
  double max_range_m = 90.0;
  double band_m = 3.0;         // só pontos a ±band_m da altura do drone
};

class SectorBuilder {
 public:
  explicit SectorBuilder(SectorConfig c = {}) : c_(c), cm_(c.count, kNoObstacle) {}

  void reset() { std::fill(cm_.begin(), cm_.end(), kNoObstacle); }

  /// Ponto no referencial do corpo, convenção ROS (FLU: x frente, y esquerda, z cima).
  void add_body_point(double x, double y, double z) {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) return;
    if (std::fabs(z) > c_.band_m) return;
    const double d = std::hypot(x, y);
    if (d < c_.min_range_m || d > c_.max_range_m) return;
    double deg = std::atan2(-y, x) * 180.0 / M_PI;  // horário a partir da proa
    if (deg < 0) deg += 360.0;
    const double width = 360.0 / c_.count;
    const int s = static_cast<int>(std::floor(deg / width + 0.5)) % c_.count;
    const auto cm = static_cast<uint16_t>(std::min(65534.0, d * 100.0));
    if (cm < cm_[s]) cm_[s] = cm;
  }

  const std::vector<uint16_t>& distances_cm() const { return cm_; }
  double increment_deg() const { return 360.0 / c_.count; }
  const SectorConfig& config() const { return c_; }

  /// Menor distância (m) entre todos os setores, ou infinito se tudo livre.
  double nearest_m() const {
    uint16_t m = kNoObstacle;
    for (auto v : cm_) m = std::min(m, v);
    return m == kNoObstacle ? std::numeric_limits<double>::infinity() : m / 100.0;
  }

 private:
  SectorConfig c_;
  std::vector<uint16_t> cm_;
};

}  // namespace aracua
