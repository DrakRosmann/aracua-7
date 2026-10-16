// Transforma a nuvem do LiDAR em distâncias por setor para a anticolisão.
//
// Publica sensor_msgs/LaserScan em /mavros/obstacle/send: o plugin
// obstacle_distance do MAVROS repassa ao ArduPilot como OBSTACLE_DISTANCE
// (use PRX1_TYPE = 2 no piloto automático). Atenção: seguindo o MAVLink,
// os setores vão da proa no sentido HORÁRIO (convenção FRD), não anti-horário
// como é usual em LaserScan.

#include <geometry_msgs/msg/pose_stamped.hpp>
#include <limits>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/laser_scan.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>
#include <std_msgs/msg/float32.hpp>

#include "aracua_onboard/pose.hpp"
#include "aracua_onboard/sectors.hpp"

using sensor_msgs::msg::LaserScan;
using sensor_msgs::msg::PointCloud2;

class ObstacleSectors : public rclcpp::Node {
 public:
  ObstacleSectors() : Node("obstacle_sectors") {
    aracua::SectorConfig c;
    c.count = static_cast<int>(declare_parameter<int64_t>("sectors", 72));
    c.min_range_m = declare_parameter<double>("min_range_m", 0.6);
    c.max_range_m = declare_parameter<double>("max_range_m", 90.0);
    c.band_m = declare_parameter<double>("band_m", 3.0);
    builder_ = aracua::SectorBuilder(c);
    mount_yaw_ = declare_parameter<double>("mount_yaw_deg", 0.0) * M_PI / 180.0;
    cloud_in_map_ = declare_parameter<bool>("cloud_in_map_frame", false);
    body_frame_ = declare_parameter<std::string>("body_frame", "base_link");
    const double hz = declare_parameter<double>("rate_hz", 10.0);

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
          have_pose_ = true;
        });
    mavros_pub_ = create_publisher<LaserScan>(declare_parameter<std::string>("mavros_topic", "/mavros/obstacle/send"), 10);
    scan_pub_ = create_publisher<LaserScan>("/aracua/obstacle_scan", 10);
    nearest_pub_ = create_publisher<std_msgs::msg::Float32>("/aracua/nearest_obstacle", 10);
    timer_ = create_wall_timer(std::chrono::duration<double>(1.0 / hz), [this] { publish(); });
  }

 private:
  void on_cloud(const PointCloud2& c) {
    if (cloud_in_map_ && !have_pose_) return;
    const double cy = std::cos(mount_yaw_), sy = std::sin(mount_yaw_);
    sensor_msgs::PointCloud2ConstIterator<float> x(c, "x"), y(c, "y"), z(c, "z");
    for (; x != x.end(); ++x, ++y, ++z) {
      double p[3] = {*x, *y, *z}, b[3];
      if (cloud_in_map_) {
        aracua::map_to_body(pose_, p, b);
      } else {
        b[0] = cy * p[0] - sy * p[1];
        b[1] = sy * p[0] + cy * p[1];
        b[2] = p[2];
      }
      builder_.add_body_point(b[0], b[1], b[2]);
    }
    got_points_ = true;
  }

  void publish() {
    if (!got_points_) return;
    const auto& cm = builder_.distances_cm();
    const auto& cfg = builder_.config();
    LaserScan s;
    s.header.stamp = now();
    s.header.frame_id = body_frame_;
    s.angle_min = 0.0f;
    s.angle_increment = static_cast<float>(builder_.increment_deg() * M_PI / 180.0);
    s.angle_max = s.angle_increment * static_cast<float>(cm.size() - 1);
    s.range_min = static_cast<float>(cfg.min_range_m);
    s.range_max = static_cast<float>(cfg.max_range_m);
    s.ranges.reserve(cm.size());
    // Setor livre = alcance máximo + 1 cm, como pede o OBSTACLE_DISTANCE (o MAVROS copia
    // ranges[] na ordem, assumindo FRD: proa = 0, sentido horário).
    for (auto d : cm)
      s.ranges.push_back(d == aracua::kNoObstacle ? s.range_max + 0.01f : d / 100.0f);
    mavros_pub_->publish(s);
    scan_pub_->publish(s);
    std_msgs::msg::Float32 n;
    n.data = static_cast<float>(builder_.nearest_m());
    nearest_pub_->publish(n);
    builder_.reset();
    got_points_ = false;
  }

  aracua::SectorBuilder builder_;
  aracua::Pose pose_;
  bool have_pose_ = false, cloud_in_map_ = false, got_points_ = false;
  double mount_yaw_ = 0;
  std::string body_frame_;
  rclcpp::Subscription<PointCloud2>::SharedPtr cloud_sub_;
  rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr pose_sub_;
  rclcpp::Publisher<LaserScan>::SharedPtr mavros_pub_, scan_pub_;
  rclcpp::Publisher<std_msgs::msg::Float32>::SharedPtr nearest_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<ObstacleSectors>());
  rclcpp::shutdown();
  return 0;
}
