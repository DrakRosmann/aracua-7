#pragma once
// Mundo sintético para testar o LiDAR no SITL: o mesmo "bairro" usado pelo
// veículo simulado da ponte e pela interface de demonstração.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <vector>

namespace aracua {

struct Box {
  double x0, y0, x1, y1, h;  // ENU, metros, base no solo
};

inline std::vector<Box> make_world() {
  uint32_t s = 11;
  auto rnd = [&s]() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return static_cast<double>(s) / 4294967295.0;
  };
  std::vector<Box> out;
  for (int bi = -5; bi < 5; ++bi) {
    for (int bj = -5; bj < 5; ++bj) {
      const double x0 = bi * 60.0 + 6, x1 = (bi + 1) * 60.0 - 6, y0 = bj * 60.0 + 6, y1 = (bj + 1) * 60.0 - 6;
      const bool park = (bi == -1 || bi == 0) && (bj == -1 || bj == 0);
      if (park || rnd() < 0.1) {
        for (int k = 0; k < 14; ++k) {
          const double cx = x0 + 3 + rnd() * (x1 - x0 - 6), cy = y0 + 3 + rnd() * (y1 - y0 - 6);
          if (std::hypot(cx, cy) < 18) continue;
          const double r = 1.3 + rnd() * 1.6;
          out.push_back({cx - r, cy - r, cx + r, cy + r, 5 + rnd() * 8});
        }
        continue;
      }
      const int nx = 1 + static_cast<int>(rnd() * 2), ny = 1 + static_cast<int>(rnd() * 3);
      const double lw = (x1 - x0) / nx, lh = (y1 - y0) / ny;
      for (int i = 0; i < nx; ++i) {
        for (int j = 0; j < ny; ++j) {
          if (rnd() < 0.12) continue;
          const double ins = 1.5 + rnd() * 2.5;
          Box b{x0 + i * lw + ins, y0 + j * lh + ins, x0 + (i + 1) * lw - ins, y0 + (j + 1) * lh - ins, 0};
          const double tall = std::max(0.25, 1 - std::hypot((b.x0 + b.x1) / 2 - 90, (b.y0 + b.y1) / 2 - 70) / 300);
          const double extra = rnd() < 0.07 ? 12.0 : 0.0;
          b.h = std::min(39.0, 5 + rnd() * 24 * tall + extra);
          out.push_back(b);
        }
      }
    }
  }
  return out;
}

/// Distância ao primeiro impacto (solo em z = 0 ou caixa) ao longo de `d` (unitário).
inline std::optional<double> raycast(const double o[3], const double d[3], double max_range,
                                     const std::vector<const Box*>& boxes) {
  double best = max_range;
  bool hit = false;
  if (d[2] < -1e-6) {
    const double t = -o[2] / d[2];
    if (t > 0 && t < best) { best = t; hit = true; }
  }
  for (const Box* b : boxes) {
    double tmin = 0, tmax = best;
    const double lo[3] = {b->x0, b->y0, 0.0}, hi[3] = {b->x1, b->y1, b->h};
    bool ok = true;
    for (int a = 0; a < 3 && ok; ++a) {
      if (std::fabs(d[a]) < 1e-9) {
        if (o[a] < lo[a] || o[a] > hi[a]) ok = false;
      } else {
        double t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
        if (t1 > t2) std::swap(t1, t2);
        tmin = std::max(tmin, t1);
        tmax = std::min(tmax, t2);
        if (tmin > tmax) ok = false;
      }
    }
    if (ok && tmin < best) { best = tmin; hit = true; }
  }
  if (!hit) return std::nullopt;
  return best;
}

}  // namespace aracua
