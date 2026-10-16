#pragma once
// Quadros binários AVX1/AOB1 enviados à ponte em terra (ver docs/protocolo.md).
// Mesmo formato que bridge/src/mapframe.rs. Tudo little-endian.

#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>
#include <utility>
#include <vector>

#include "aracua_onboard/voxel_map.hpp"

namespace aracua {

constexpr size_t kAvx1Header = 36;
constexpr size_t kAvx1Point = 8;
constexpr size_t kAob1Header = 16;
/// Setor sem leitura no AOB1 (e no OBSTACLE_DISTANCE do MAVLink).
constexpr uint16_t kNoObstacle = std::numeric_limits<uint16_t>::max();
/// Datagrama padrão: cabe num pacote Ethernet/Wi-Fi sem fragmentar (rádios IP perdem
/// o quadro inteiro se um fragmento se perde).
constexpr size_t kDefaultDatagramBytes = 1400;

/// Quantos voxels cabem num quadro AVX1 de até `datagram_bytes`.
constexpr size_t voxels_per_frame(size_t datagram_bytes) {
  return datagram_bytes > kAvx1Header ? (datagram_bytes - kAvx1Header) / kAvx1Point : 0;
}

namespace detail {
template <typename T>
inline void put(std::vector<uint8_t>& b, T v) {
  static_assert(std::is_trivially_copyable<T>::value, "tipo simples");
  uint8_t raw[sizeof(T)];
  std::memcpy(raw, &v, sizeof(T));
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
  for (size_t i = 0; i < sizeof(T) / 2; ++i) std::swap(raw[i], raw[sizeof(T) - 1 - i]);
#endif
  b.insert(b.end(), raw, raw + sizeof(T));
}
}  // namespace detail

inline std::vector<uint8_t> encode_voxels(bool reset, double lat, double lon, float alt, float voxel_m,
                                          const Voxel* v, size_t n) {
  std::vector<uint8_t> b;
  b.reserve(kAvx1Header + n * kAvx1Point);
  b.insert(b.end(), {'A', 'V', 'X', '1'});
  detail::put<uint16_t>(b, 1);
  detail::put<uint16_t>(b, reset ? 1 : 0);
  detail::put<double>(b, lat);
  detail::put<double>(b, lon);
  detail::put<float>(b, alt);
  detail::put<float>(b, voxel_m);
  detail::put<uint32_t>(b, static_cast<uint32_t>(n));
  for (size_t i = 0; i < n; ++i) {
    detail::put<int16_t>(b, v[i].e);
    detail::put<int16_t>(b, v[i].n);
    detail::put<int16_t>(b, v[i].u);
    b.push_back(v[i].cls);
    b.push_back(v[i].intensity);
  }
  return b;
}

inline std::vector<uint8_t> encode_sectors(float increment_deg, float max_range_m,
                                           const std::vector<uint16_t>& cm) {
  std::vector<uint8_t> b;
  b.reserve(kAob1Header + cm.size() * 2);
  b.insert(b.end(), {'A', 'O', 'B', '1'});
  detail::put<uint16_t>(b, 1);
  detail::put<uint16_t>(b, static_cast<uint16_t>(cm.size()));
  detail::put<float>(b, increment_deg);
  detail::put<float>(b, max_range_m);
  for (auto d : cm) detail::put<uint16_t>(b, d);
  return b;
}

}  // namespace aracua
