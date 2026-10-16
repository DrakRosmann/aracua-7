// LiDAR simulado para testes com o SITL do ArduPilot: lê a pose do MAVROS,
// lança raios contra o bairro sintético e publica a nuvem no referencial do
// corpo (FLU), como um sensor real montado nivelado no drone.

#include <geometry_msgs/msg/pose_stamped.hpp>
#include <cstring>
#include <random>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>

#include "aracua_onboard/pose.hpp"
#include "aracua_onboard/sim_world.hpp"

using sensor_msgs::msg::PointCloud2;
using sensor_msgs::msg::PointField;

class SimLidar : public rclcpp::Node {
 public:
  SimLidar() : Node("sim_lidar"), world_(aracua::make_world()), rng_(42) {
    range_ = declare_parameter<double>("range_m", 90.0);
    az_step_ = declare_parameter<double>("azimuth_step_deg", 2.0);
    frame_ = declare_parameter<std::string>("frame_id", "base_link");
    noise_ = declare_parameter<double>("noise_m", 0.03);
    for (double d : declare_parameter<std::vector<double>>("channels_deg", std::vector<double>{-30, -22, -15, -9, -4, 0, 4, 10}))
      channels_.push_back(d * M_PI / 180.0);
    const double hz = declare_parameter<double>("rate_hz", 10.0);

    pose_sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
        declare_parameter<std::string>("pose_topic", "/mavros/local_position/pose"), rclcpp::SensorDataQoS(),
        [this](geometry_msgs::msg::PoseStamped::ConstSharedPtr m) {
          pose_.t[0] = m->pose.position.x;
          pose_.t[1] = m->pose.position.y;
          pose_.t[2] = m->pose.position.z;
          pose_.q = {m->pose.orientation.w, m->pose.orientation.x, m->pose.orientation.y, m->pose.orientation.z};
          have_pose_ = true;
        });
    pub_ = create_publisher<PointCloud2>(declare_parameter<std::string>("cloud_topic", "/lidar/points"), rclcpp::SensorDataQoS());
    timer_ = create_wall_timer(std::chrono::duration<double>(1.0 / hz), [this] { scan(); });
    RCLCPP_INFO(get_logger(), "LiDAR simulado: %zu obstáculos, %zu canais, alcance %.0f m", world_.size(),
                channels_.size(), range_);
  }

 private:
  void scan() {
    if (!have_pose_) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "aguardando /mavros/local_position/pose");
      return;
    }
    std::vector<const aracua::Box*> near;
    for (const auto& b : world_)
      if (std::hypot((b.x0 + b.x1) / 2 - pose_.t[0], (b.y0 + b.y1) / 2 - pose_.t[1]) < range_ + 30) near.push_back(&b);

    double origin[3] = {pose_.t[0], pose_.t[1], std::max(0.3, pose_.t[2] + 0.1)};
    std::normal_distribution<double> noise(0.0, noise_);
    std::vector<float> pts;
    pts.reserve(static_cast<size_t>(360.0 / az_step_) * channels_.size() * 4);
    for (double az = 0; az < 360.0; az += az_step_) {
      const double a = az * M_PI / 180.0;
      for (double el : channels_) {
        // Raio no corpo (FLU) → mapa (ENU).
        const double b[3] = {std::cos(el) * std::cos(a), std::cos(el) * std::sin(a), std::sin(el)};
        double d[3];
        aracua::rotate(pose_.q, b, d);
        const auto t = aracua::raycast(origin, d, range_, near);
        if (!t) continue;
        const double r = *t + noise(rng_);
        const double hit[3] = {origin[0] + d[0] * r, origin[1] + d[1] * r, origin[2] + d[2] * r};
        double body[3];
        aracua::map_to_body(pose_, hit, body);
        pts.insert(pts.end(), {static_cast<float>(body[0]), static_cast<float>(body[1]), static_cast<float>(body[2]),
                               hit[2] < 0.2 ? 60.0f : 180.0f});
      }
    }
    PointCloud2 c;
    c.header.stamp = now();
    c.header.frame_id = frame_;
    sensor_msgs::PointCloud2Modifier mod(c);
    mod.setPointCloud2Fields(4, "x", 1, PointField::FLOAT32, "y", 1, PointField::FLOAT32, "z", 1, PointField::FLOAT32,
                             "intensity", 1, PointField::FLOAT32);
    mod.resize(pts.size() / 4);
    std::memcpy(c.data.data(), pts.data(), pts.size() * sizeof(float));
    pub_->publish(c);
  }

  std::vector<aracua::Box> world_;
  std::vector<double> channels_;
  double range_ = 90, az_step_ = 2, noise_ = 0.03;
  std::string frame_;
  aracua::Pose pose_;
  bool have_pose_ = false;
  std::mt19937 rng_;
  rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr pose_sub_;
  rclcpp::Publisher<PointCloud2>::SharedPtr pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<SimLidar>());
  rclcpp::shutdown();
  return 0;
}
