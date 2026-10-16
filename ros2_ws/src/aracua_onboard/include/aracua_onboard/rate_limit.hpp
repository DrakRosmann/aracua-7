#pragma once
// Balde de fichas para limitar a banda do rádio: enche a `rate` bytes/s até
// `burst` bytes; cada envio gasta o seu tamanho. Pode ficar negativo para que
// mensagens prioritárias (setores de anticolisão) nunca esperem — o mapa é
// que cede a vez.

#include <algorithm>
#include <cstddef>

namespace aracua {

class TokenBucket {
 public:
  TokenBucket(double bytes_per_s, double burst_bytes)
      : rate_(std::max(0.0, bytes_per_s)), burst_(std::max(1.0, burst_bytes)), tokens_(burst_) {}

  /// Avança o relógio `dt_s` segundos.
  void refill(double dt_s) { tokens_ = std::min(burst_, tokens_ + rate_ * std::max(0.0, dt_s)); }

  /// Há fichas para `bytes`?
  bool can_send(size_t bytes) const { return tokens_ >= static_cast<double>(bytes); }

  /// Gasta `bytes` (mesmo sem saldo).
  void spend(size_t bytes) { tokens_ -= static_cast<double>(bytes); }

  double tokens() const { return tokens_; }
  double rate() const { return rate_; }

 private:
  double rate_, burst_, tokens_;
};

}  // namespace aracua
