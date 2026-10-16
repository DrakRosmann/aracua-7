// Acumula as nuvens do LiDAR num mapa de voxels e publica só as células novas.
//
// Entrada: nuvem no referencial do corpo (padrão) + pose do veículo no mapa,
// ou nuvem já registrada no mapa (ex.: /cloud_registered do FAST-LIO).
// Saída: /aracua/voxels_delta (novidades, para o map_link) e /aracua/map
// (mapa inteiro a 1 Hz, para o RViz).

#include <algorithm>
#include <chrono>
#include <optional>
#include <geometry_msgs/msg/pose_stamped.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>
#include <std_msgs/msg/empty.hpp>
#include <std_srvs/srv/trigger.hpp>

#include "aracua_onboard/pose.hpp"
#include "aracua_onboard/voxel_map.hpp"

using sensor_msgs::msg::PointCloud2;
using sensor_msgs::msg::PointField;
using namespace std::chrono_literals;

namespace {

/// Campo `name` em float32? (intensidade vem como float, uint8 ou uint16 conforme o LiDAR.)
bool has_float_field(const PointCloud2& c, const std::string& name) {
  for (const auto& f : c.fields)
    if (f.name == name) return f.datatype == PointField::FLOAT32 && f.count == 1;
  return false;
}

PointCloud2 to_cloud(const std::vector<aracua::Voxel>& v, double res, const std::string& frame, const rclcpp::Time& stamp) {
  PointCloud2 c;
  c.header.frame_id = frame;
  c.header.stamp = stamp;
  sensor_msgs::PointCloud2Modifier mod(c);
  mod.setPointCloud2Fields(5, "x", 1, PointField::FLOAT32, "y", 1, PointField::FLOAT32, "z", 1, PointField::FLOAT32,
                           "cls", 1, PointField::UINT8, "intensity", 1, PointField::UINT8);
  mod.resize(v.size());
  sensor_msgs::PointCloud2Iterator<float> x(c, "x"), y(c, "y"), z(c, "z");
  sensor_msgs::PointCloud2Iterator<uint8_t> cls(c, "cls"), in(c, "intensity");
  for (const auto& p : v) {
    *x = static_cast<float>(p.e * res);
    *y = static_cast<float>(p.n * res);
    *z = static_cast<float>(p.u * res);
    *cls = p.cls;
    *in = p.intensity;
    ++x; ++y; ++z; ++cls; ++in;
  }
  return c;
}

}  // namespace

class VoxelMapper : public rclcpp::Node {
 public:
  VoxelMapper() : Node("voxel_mapper") {
    map_frame_ = declare_parameter<std::string>("map_frame", "map");
    cloud_in_map_ = declare_parameter<bool>("cloud_in_map_frame", false);
    max_pose_age_ = declare_parameter<double>("max_pose_age_s", 0.3);
    const double res = declare_parameter<double>("voxel_size", 1.0);
    const double ground = declare_parameter<double>("ground_below_m", 0.4);
    const int64_t max_vox = declare_parameter<int64_t>("max_voxels", 2000000);
    const double delta_hz = declare_parameter<double>("delta_rate_hz", 5.0);
    map_ = aracua::VoxelMap(res, ground, static_cast<size_t>(max_vox));

    cloud_sub_ = create_subscription<PointCloud2>(
        declare_parameter<std::string>("cloud_topic", "/lidar/points"), rclcpp::SensorDataQoS(),
        [this](PointCloud2::ConstSharedPtr m) { on_cloud(*m); });
    pose_sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
        declare_parameter<std::string>("pose_topic", "/mavros/local_position/pose"), rclcpp::SensorDataQoS(),
        [this](geometry_msgs::msg::PoseStamped::ConstSharedPtr m) {
          pose_.t[0] = m->pose.position.x;
          pose_.t[1] = m->pose.position.y;
          pose_.t[2] = m->pose.position.z;
          pose_.q = {m->pose.orientation.w, m->pose.orientation.x, m->pose.orientation.y, m->pose.orientation.z};
          pose_time_ = now();
          have_pose_ = true;
        });

    delta_pub_ = create_publisher<PointCloud2>("/aracua/voxels_delta", rclcpp::QoS(50).reliable());
    map_pub_ = create_publisher<PointCloud2>("/aracua/map", rclcpp::QoS(1).transient_local());
    reset_pub_ = create_publisher<std_msgs::msg::Empty>("/aracua/map_reset_event", 10);
    reset_srv_ = create_service<std_srvs::srv::Trigger>(
        "~/reset", [this](const std::shared_ptr<std_srvs::srv::Trigger::Request>,
                          std::shared_ptr<std_srvs::srv::Trigger::Response> res) {
          map_.clear();
          all_.clear();
          delta_.clear();
          reset_pub_->publish(std_msgs::msg::Empty());
          res->success = true;
          res->message = "mapa zerado";
          RCLCPP_INFO(get_logger(), "mapa zerado");
        });

    delta_timer_ = create_wall_timer(std::chrono::duration<double>(1.0 / delta_hz), [this] { publish_delta(); });
    map_timer_ = create_wall_timer(1s, [this] { publish_map(); });
    RCLCPP_INFO(get_logger(), "mapeando com voxels de %.2f m (%s)", res,
                cloud_in_map_ ? "nuvem já registrada no mapa" : "nuvem no corpo + pose");
  }

 private:
  void on_cloud(const PointCloud2& c) {
    if (!cloud_in_map_) {
      if (!have_pose_) {
        RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "sem pose do veículo ainda; nuvem descartada");
        return;
      }
      if ((now() - pose_time_).seconds() > max_pose_age_) {
        RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "pose atrasada; nuvem descartada");
        return;
      }
    }
    const bool intensity = has_float_field(c, "intensity");
    sensor_msgs::PointCloud2ConstIterator<float> x(c, "x"), y(c, "y"), z(c, "z");
    std::optional<sensor_msgs::PointCloud2ConstIterator<float>> in;
    if (intensity) in.emplace(c, "intensity");
    aracua::Voxel v{};
    for (; x != x.end(); ++x, ++y, ++z) {
      double p[3] = {*x, *y, *z}, m[3];
      if (cloud_in_map_) {
        m[0] = p[0]; m[1] = p[1]; m[2] = p[2];
      } else {
        aracua::body_to_map(pose_, p, m);
      }
      const uint8_t i = intensity ? static_cast<uint8_t>(std::clamp(**in, 0.0f, 255.0f)) : 128;
      if (intensity) ++(*in);
      if (map_.insert(m[0], m[1], m[2], i, v)) {
        delta_.push_back(v);
        all_.push_back(v);
      }
    }
    if (map_.full()) RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 10000, "mapa atingiu max_voxels");
  }

  void publish_delta() {
    if (delta_.empty()) return;
    delta_pub_->publish(to_cloud(delta_, map_.resolution(), map_frame_, now()));
    delta_.clear();
  }

  void publish_map() {
    if (map_pub_->get_subscription_count() == 0 || all_.size() == last_map_size_) return;
    map_pub_->publish(to_cloud(all_, map_.resolution(), map_frame_, now()));
    last_map_size_ = all_.size();
  }

  aracua::VoxelMap map_;
  std::vector<aracua::Voxel> delta_, all_;
  size_t last_map_size_ = 0;
  aracua::Pose pose_;
  rclcpp::Time pose_time_;
  bool have_pose_ = false, cloud_in_map_ = false;
  double max_pose_age_ = 0.3;
  std::string map_frame_;
  rclcpp::Subscription<PointCloud2>::SharedPtr cloud_sub_;
  rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr pose_sub_;
  rclcpp::Publisher<PointCloud2>::SharedPtr delta_pub_, map_pub_;
  rclcpp::Publisher<std_msgs::msg::Empty>::SharedPtr reset_pub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr reset_srv_;
  rclcpp::TimerBase::SharedPtr delta_timer_, map_timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<VoxelMapper>());
  rclcpp::shutdown();
  return 0;
}
