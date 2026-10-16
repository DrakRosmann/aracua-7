// Testes do núcleo sem ROS: mapa de voxels, setores, quadros binários,
// transformações e o mundo sintético.

#include <gtest/gtest.h>

#include <cmath>
#include <fstream>
#include <iterator>
#include <string>

#include "aracua_onboard/map_frame.hpp"
#include "aracua_onboard/pose.hpp"
#include "aracua_onboard/rate_limit.hpp"
#include "aracua_onboard/sectors.hpp"
#include "aracua_onboard/sim_world.hpp"
#include "aracua_onboard/voxel_map.hpp"

using namespace aracua;

TEST(VoxelMap, InsereUmaVezPorCelula) {
  VoxelMap m(1.0, 0.4);
  Voxel v{};
  EXPECT_TRUE(m.insert(10.2, -3.4, 5.0, 100, v));
  EXPECT_EQ(v.e, 10);
  EXPECT_EQ(v.n, -3);
  EXPECT_EQ(v.u, 5);
  EXPECT_EQ(v.cls, 1);
  EXPECT_FALSE(m.insert(9.8, -3.2, 4.9, 100, v));  // mesma célula
  EXPECT_TRUE(m.insert(0.0, 0.0, 0.1, 50, v));
  EXPECT_EQ(v.cls, 0);  // perto do solo
  EXPECT_EQ(m.size(), 2u);
}

TEST(VoxelMap, RejeitaInvalidosERespeitaLimite) {
  VoxelMap m(1.0, 0.4, 2);
  Voxel v{};
  EXPECT_FALSE(m.insert(NAN, 0, 0, 0, v));
  EXPECT_FALSE(m.insert(1e9, 0, 0, 0, v));
  EXPECT_TRUE(m.insert(1, 1, 1, 0, v));
  EXPECT_TRUE(m.insert(2, 2, 2, 0, v));
  EXPECT_TRUE(m.full());
  EXPECT_FALSE(m.insert(3, 3, 3, 0, v));
}

TEST(Sectors, ProaEHorario) {
  SectorBuilder s;
  s.add_body_point(10, 0, 0);   // frente → setor 0
  s.add_body_point(0, -5, 0);   // direita (y negativo em FLU) → 90° → setor 18
  s.add_body_point(0, 8, 0.5);  // esquerda → 270° → setor 54
  s.add_body_point(3, 0, 10);   // fora da faixa de altura: ignorado
  s.add_body_point(0.2, 0, 0);  // dentro do raio mínimo: ignorado
  const auto& d = s.distances_cm();
  EXPECT_EQ(d[0], 1000);
  EXPECT_EQ(d[18], 500);
  EXPECT_EQ(d[54], 800);
  EXPECT_EQ(d[36], kNoObstacle);
  EXPECT_NEAR(s.nearest_m(), 5.0, 1e-9);
  s.reset();
  EXPECT_TRUE(std::isinf(s.nearest_m()));
}

TEST(MapFrame, LayoutAvx1) {
  Voxel v[2] = {{-3, 7, 12, 1, 200}, {100, -250, 0, 0, 9}};
  auto b = encode_voxels(true, -23.5, -46.6, 760.0f, 1.0f, v, 2);
  ASSERT_EQ(b.size(), kAvx1Header + 2 * kAvx1Point);
  EXPECT_EQ(std::string(b.begin(), b.begin() + 4), "AVX1");
  EXPECT_EQ(b[4], 1);   // versão
  EXPECT_EQ(b[6], 1);   // flag de reset
  EXPECT_EQ(b[32], 2);  // contagem
  int16_t e;
  std::memcpy(&e, &b[36], 2);
  EXPECT_EQ(e, -3);
  EXPECT_EQ(b[36 + 6], 1);
  EXPECT_EQ(b[36 + 7], 200);
  double lat;
  std::memcpy(&lat, &b[8], 8);
  EXPECT_EQ(lat, -23.5);
}

TEST(MapFrame, LayoutAob1) {
  std::vector<uint16_t> cm(72, kNoObstacle);
  cm[3] = 1234;
  auto b = encode_sectors(5.0f, 90.0f, cm);
  ASSERT_EQ(b.size(), kAob1Header + 72 * 2);
  EXPECT_EQ(std::string(b.begin(), b.begin() + 4), "AOB1");
  EXPECT_EQ(b[6], 72);
  uint16_t d3;
  std::memcpy(&d3, &b[16 + 6], 2);
  EXPECT_EQ(d3, 1234);
}

TEST(Pose, IdaEVolta) {
  Pose p;
  p.t[0] = 5; p.t[1] = -2; p.t[2] = 30;
  const double yaw = 0.7;  // rotação pura em z
  p.q = {std::cos(yaw / 2), 0, 0, std::sin(yaw / 2)};
  const double b[3] = {10, 0, 0};
  double m[3], back[3];
  body_to_map(p, b, m);
  EXPECT_NEAR(m[0], 5 + 10 * std::cos(yaw), 1e-9);
  EXPECT_NEAR(m[1], -2 + 10 * std::sin(yaw), 1e-9);
  EXPECT_NEAR(m[2], 30, 1e-9);
  map_to_body(p, m, back);
  for (int i = 0; i < 3; ++i) EXPECT_NEAR(back[i], b[i], 1e-9);
  EXPECT_NEAR(yaw_of(p.q), yaw, 1e-9);
}

TEST(SimWorld, SoloEPredio) {
  auto w = make_world();
  EXPECT_GT(w.size(), 100u);
  std::vector<const Box*> all;
  for (auto& b : w) all.push_back(&b);
  const double o[3] = {0, 0, 50}, down[3] = {0, 0, -1};
  auto t = raycast(o, down, 90, all);  // o home fica numa praça aberta
  ASSERT_TRUE(t.has_value());
  EXPECT_NEAR(*t, 50.0, 1e-9);
  // Um raio horizontal a 2 m de altura acaba batendo em algo dentro de 90 m.
  int hits = 0;
  for (int k = 0; k < 36; ++k) {
    const double a = k * M_PI / 18, o2[3] = {0, 0, 2}, d[3] = {std::cos(a), std::sin(a), 0};
    if (raycast(o2, d, 90, all)) ++hits;
  }
  EXPECT_GT(hits, 20);
}

// Quadros de referência compartilhados com a ponte (Rust) e a interface (TypeScript).
#ifndef ARACUA_FIXTURES
#define ARACUA_FIXTURES "../../../docs/fixtures"
#endif

static std::vector<uint8_t> fixture(const std::string& name) {
  std::ifstream f(std::string(ARACUA_FIXTURES) + "/" + name, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

TEST(MapFrame, IgualAoQuadroDeReferenciaAvx1) {
  const Voxel v[3] = {{-3, 7, 12, 1, 200}, {100, -250, 0, 0, 9}, {32767, -32768, -1, 1, 255}};
  const auto ref = fixture("avx1_exemplo.bin");
  ASSERT_FALSE(ref.empty()) << "docs/fixtures não encontrado";
  EXPECT_EQ(encode_voxels(true, -23.55052, -46.63331, 760.0f, 0.5f, v, 3), ref);
}

TEST(MapFrame, IgualAoQuadroDeReferenciaAob1) {
  std::vector<uint16_t> cm(72, kNoObstacle);
  cm[0] = 150;
  cm[18] = 420;
  cm[71] = 4001;
  const auto ref = fixture("aob1_exemplo.bin");
  ASSERT_FALSE(ref.empty()) << "docs/fixtures não encontrado";
  EXPECT_EQ(encode_sectors(5.0f, 40.0f, cm), ref);
}

TEST(MapFrame, DatagramaNaoFragmenta) {
  EXPECT_EQ(voxels_per_frame(1400), 170u);
  EXPECT_LE(kAvx1Header + voxels_per_frame(1400) * kAvx1Point, 1400u);
  EXPECT_EQ(voxels_per_frame(10), 0u);
}

TEST(TokenBucket, LimitaEPrioriza) {
  TokenBucket b(1000.0, 500.0);  // 1000 B/s, rajada de 500 B
  EXPECT_TRUE(b.can_send(500));
  b.spend(500);
  EXPECT_FALSE(b.can_send(1));
  b.refill(0.1);
  EXPECT_TRUE(b.can_send(100));
  EXPECT_FALSE(b.can_send(101));
  b.spend(300);  // prioridade: gasta mesmo sem saldo
  EXPECT_LT(b.tokens(), 0);
  b.refill(10);  // não passa da rajada
  EXPECT_DOUBLE_EQ(b.tokens(), 500.0);
}
