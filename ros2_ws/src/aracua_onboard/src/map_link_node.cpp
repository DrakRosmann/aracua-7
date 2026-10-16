// Envia o mapa LiDAR e os setores de obstáculo para a ponte em terra por UDP,
// respeitando um limite de banda para não saturar o rádio de telemetria.
//
// A banda é um balde de fichas único: os setores (pequenos, para a anticolisão
// na tela) saem sempre; os voxels usam o que sobra, em datagramas que não
// fragmentam. A origem geográfica vem do gp_origin do MAVROS; se ele não
// chegar (o ArduPilot só manda GPS_GLOBAL_ORIGIN quando o EKF a define), é
// estimada a partir do GPS e da posição local.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <deque>
#include <optional>
#include <geographic_msgs/msg/geo_point_stamped.hpp>
#include <geometry_msgs/msg/pose_stamped.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/nav_sat_fix.hpp>
#include <sensor_msgs/msg/laser_scan.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>
#include <std_msgs/msg/empty.hpp>

#include "aracua_onboard/map_frame.hpp"
#include "aracua_onboard/rate_limit.hpp"

using sensor_msgs::msg::LaserScan;
using sensor_msgs::msg::PointCloud2;

class MapLink : public rclcpp::Node {
 public:
  MapLink() : Node("map_link") {
    const std::string host = declare_parameter<std::string>("ground_host", "127.0.0.1");
    const int port = static_cast<int>(declare_parameter<int64_t>("ground_port", 14600));
    voxel_m_ = declare_parameter<double>("voxel_size", 1.0);
    const double kbps = declare_parameter<double>("max_kbps", 400.0);
    // Meio segundo de rajada: suaviza sem estourar o buffer do rádio.
    bucket_ = aracua::TokenBucket(kbps * 1000.0 / 8.0, std::max(2000.0, kbps * 1000.0 / 8.0 * 0.5));
    datagram_ = static_cast<size_t>(std::clamp<int64_t>(
        declare_parameter<int64_t>("max_datagram_bytes", static_cast<int64_t>(aracua::kDefaultDatagramBytes)),
        static_cast<int64_t>(aracua::kAvx1Header + aracua::kAvx1Point), 65000));
    origin_timeout_s_ = declare_parameter<double>("origin_timeout_s", 10.0);
    // Origem usada se o MAVROS ainda não publicou a do EKF.
    origin_lat_ = declare_parameter<double>("origin_lat", 0.0);
    origin_lon_ = declare_parameter<double>("origin_lon", 0.0);
    origin_alt_ = declare_parameter<double>("origin_alt", 0.0);
    have_origin_ = origin_lat_ != 0.0 || origin_lon_ != 0.0;

    sock_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    std::memset(&dest_, 0, sizeof(dest_));
    dest_.sin_family = AF_INET;
    dest_.sin_port = htons(static_cast<uint16_t>(port));
    if (sock_ < 0 || ::inet_pton(AF_INET, host.c_str(), &dest_.sin_addr) != 1) {
      throw std::runtime_error("ground_host inválido ou socket indisponível: " + host);
    }

    origin_sub_ = create_subscription<geographic_msgs::msg::GeoPointStamped>(
        declare_parameter<std::string>("origin_topic", "/mavros/global_position/gp_origin"), rclcpp::SensorDataQoS(),
        [this](geographic_msgs::msg::GeoPointStamped::ConstSharedPtr m) {
          if (!origin_from_ekf_ || std::fabs(m->position.latitude - origin_lat_) > 1e-7) {
            RCLCPP_INFO(get_logger(), "origem do mapa (EKF): %.7f, %.7f", m->position.latitude, m->position.longitude);
          }
          origin_lat_ = m->position.latitude;
          origin_lon_ = m->position.longitude;
          origin_alt_ = m->position.altitude;
          have_origin_ = origin_from_ekf_ = true;
        });
    // Plano B para a origem: GPS menos o deslocamento local (ENU) no mesmo instante.
    fix_sub_ = create_subscription<sensor_msgs::msg::NavSatFix>(
        declare_parameter<std::string>("fix_topic", "/mavros/global_position/global"), rclcpp::SensorDataQoS(),
        [this](sensor_msgs::msg::NavSatFix::ConstSharedPtr m) {
          if (m->status.status >= sensor_msgs::msg::NavSatStatus::STATUS_FIX) last_fix_ = *m;
        });
    pose_sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
        declare_parameter<std::string>("pose_topic", "/mavros/local_position/pose"), rclcpp::SensorDataQoS(),
        [this](geometry_msgs::msg::PoseStamped::ConstSharedPtr m) { last_pose_ = *m; });
    started_ = now();
    delta_sub_ = create_subscription<PointCloud2>("/aracua/voxels_delta", rclcpp::QoS(50).reliable(),
                                                  [this](PointCloud2::ConstSharedPtr m) { on_delta(*m); });
    reset_sub_ = create_subscription<std_msgs::msg::Empty>("/aracua/map_reset_event", 10,
                                                           [this](std_msgs::msg::Empty::ConstSharedPtr) {
                                                             queue_.clear();
                                                             reset_next_ = true;
                                                           });
    scan_sub_ = create_subscription<LaserScan>("/aracua/obstacle_scan", 10,
                                               [this](LaserScan::ConstSharedPtr m) { on_scan(*m); });
    timer_ = create_wall_timer(std::chrono::milliseconds(50), [this] { flush(); });
    last_flush_ = now();
    RCLCPP_INFO(get_logger(), "enviando mapa para %s:%d (até %.0f kbit/s, datagramas de até %zu bytes)", host.c_str(),
                port, kbps, datagram_);
  }

  ~MapLink() override {
    if (sock_ >= 0) ::close(sock_);
  }

 private:
  void on_delta(const PointCloud2& c) {
    sensor_msgs::PointCloud2ConstIterator<float> x(c, "x"), y(c, "y"), z(c, "z");
    sensor_msgs::PointCloud2ConstIterator<uint8_t> cls(c, "cls"), in(c, "intensity");
    for (; x != x.end(); ++x, ++y, ++z, ++cls, ++in) {
      queue_.push_back(aracua::Voxel{static_cast<int16_t>(std::lround(*x / voxel_m_)),
                                     static_cast<int16_t>(std::lround(*y / voxel_m_)),
                                     static_cast<int16_t>(std::lround(*z / voxel_m_)), *cls, *in});
    }
    if (queue_.size() > kMaxQueue) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 10000, "fila de voxels cheia; descartando os mais antigos");
      queue_.erase(queue_.begin(), queue_.begin() + static_cast<long>(queue_.size() - kMaxQueue));
    }
  }

  void on_scan(const LaserScan& s) {
    std::vector<uint16_t> cm;
    cm.reserve(s.ranges.size());
    for (float r : s.ranges)
      cm.push_back(!std::isfinite(r) || r > s.range_max ? aracua::kNoObstacle
                                                         : static_cast<uint16_t>(std::min(65534.0f, r * 100.0f)));
    // Prioridade: sai mesmo sem fichas; o mapa espera.
    const auto frame = aracua::encode_sectors(static_cast<float>(s.angle_increment * 180.0 / M_PI), s.range_max, cm);
    bucket_.spend(frame.size());
    send(frame);
  }

  void estimate_origin() {
    if (have_origin_ || (now() - started_).seconds() < origin_timeout_s_ || !last_fix_ || !last_pose_) return;
    // Plano local: suficiente para os poucos quilômetros de um voo.
    constexpr double kEarthR = 6378137.0;
    const double lat = last_fix_->latitude, e = last_pose_->pose.position.x, n = last_pose_->pose.position.y;
    origin_lat_ = lat - n / kEarthR * 180.0 / M_PI;
    origin_lon_ = last_fix_->longitude - e / (kEarthR * std::cos(lat * M_PI / 180.0)) * 180.0 / M_PI;
    origin_alt_ = last_fix_->altitude - last_pose_->pose.position.z;
    have_origin_ = true;
    RCLCPP_WARN(get_logger(), "sem gp_origin do MAVROS em %.0f s; origem estimada pelo GPS: %.7f, %.7f",
                origin_timeout_s_, origin_lat_, origin_lon_);
  }

  void flush() {
    const auto t = now();
    bucket_.refill((t - last_flush_).seconds());
    last_flush_ = t;
    estimate_origin();
    if (!have_origin_) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 10000, "aguardando origem do mapa (gp_origin, GPS ou parâmetros)");
      return;
    }
    const size_t per_frame = aracua::voxels_per_frame(datagram_);
    while (!queue_.empty() || reset_next_) {
      const size_t n = std::min(queue_.size(), per_frame);
      const size_t bytes = aracua::kAvx1Header + n * aracua::kAvx1Point;
      if (!bucket_.can_send(bytes)) break;
      std::vector<aracua::Voxel> chunk(queue_.begin(), queue_.begin() + static_cast<long>(n));
      send(aracua::encode_voxels(reset_next_, origin_lat_, origin_lon_, static_cast<float>(origin_alt_),
                                 static_cast<float>(voxel_m_), chunk.data(), chunk.size()));
      bucket_.spend(bytes);
      queue_.erase(queue_.begin(), queue_.begin() + static_cast<long>(n));
      reset_next_ = false;
      if (n == 0) break;
    }
  }

  void send(const std::vector<uint8_t>& b) {
    ::sendto(sock_, b.data(), b.size(), 0, reinterpret_cast<const sockaddr*>(&dest_), sizeof(dest_));
  }

  static constexpr size_t kMaxQueue = 2'000'000;

  int sock_ = -1;
  sockaddr_in dest_{};
  double voxel_m_ = 1.0, origin_lat_ = 0, origin_lon_ = 0, origin_alt_ = 0, origin_timeout_s_ = 10.0;
  bool have_origin_ = false, origin_from_ekf_ = false, reset_next_ = true;
  aracua::TokenBucket bucket_{50000.0, 25000.0};
  size_t datagram_ = aracua::kDefaultDatagramBytes;
  rclcpp::Time started_, last_flush_;
  std::optional<sensor_msgs::msg::NavSatFix> last_fix_;
  std::optional<geometry_msgs::msg::PoseStamped> last_pose_;
  std::deque<aracua::Voxel> queue_;
  rclcpp::Subscription<geographic_msgs::msg::GeoPointStamped>::SharedPtr origin_sub_;
  rclcpp::Subscription<sensor_msgs::msg::NavSatFix>::SharedPtr fix_sub_;
  rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr pose_sub_;
  rclcpp::Subscription<PointCloud2>::SharedPtr delta_sub_;
  rclcpp::Subscription<std_msgs::msg::Empty>::SharedPtr reset_sub_;
  rclcpp::Subscription<LaserScan>::SharedPtr scan_sub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<MapLink>());
  rclcpp::shutdown();
  return 0;
}
