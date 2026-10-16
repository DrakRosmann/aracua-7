#pragma once
// Rotação por quatérnio e transformação rígida, sem depender de tf2/Eigen.

#include <cmath>

namespace aracua {

struct Quat {
  double w = 1, x = 0, y = 0, z = 0;
};

struct Pose {
  double t[3] = {0, 0, 0};
  Quat q;
};

/// v' = q · v · q*
inline void rotate(const Quat& q, const double v[3], double out[3]) {
  const double ux = q.x, uy = q.y, uz = q.z, s = q.w;
  const double dot = ux * v[0] + uy * v[1] + uz * v[2];
  const double uu = ux * ux + uy * uy + uz * uz;
  const double cx = uy * v[2] - uz * v[1], cy = uz * v[0] - ux * v[2], cz = ux * v[1] - uy * v[0];
  out[0] = 2 * dot * ux + (s * s - uu) * v[0] + 2 * s * cx;
  out[1] = 2 * dot * uy + (s * s - uu) * v[1] + 2 * s * cy;
  out[2] = 2 * dot * uz + (s * s - uu) * v[2] + 2 * s * cz;
}

inline Quat conj(const Quat& q) { return {q.w, -q.x, -q.y, -q.z}; }

/// Ponto no referencial do corpo → referencial do mapa.
inline void body_to_map(const Pose& p, const double b[3], double m[3]) {
  rotate(p.q, b, m);
  m[0] += p.t[0];
  m[1] += p.t[1];
  m[2] += p.t[2];
}

/// Ponto no referencial do mapa → referencial do corpo.
inline void map_to_body(const Pose& p, const double m[3], double b[3]) {
  const double d[3] = {m[0] - p.t[0], m[1] - p.t[1], m[2] - p.t[2]};
  rotate(conj(p.q), d, b);
}

/// Guinada (rad, ENU: 0 = leste, anti-horário) a partir do quatérnio.
inline double yaw_of(const Quat& q) {
  return std::atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

}  // namespace aracua
