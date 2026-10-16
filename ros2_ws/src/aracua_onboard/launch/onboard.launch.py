"""Nós de bordo: mapeamento, anticolisão e envio do mapa à estação de solo.

    ros2 launch aracua_onboard onboard.launch.py ground_host:=192.168.1.10

O driver do LiDAR e o MAVROS são iniciados à parte (ou pelo sitl.launch.py).
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    params = PathJoinSubstitution([FindPackageShare("aracua_onboard"), "config", "onboard.yaml"])
    ground_host = LaunchConfiguration("ground_host")
    cloud_topic = LaunchConfiguration("cloud_topic")

    return LaunchDescription([
        DeclareLaunchArgument("ground_host", default_value="127.0.0.1",
                              description="IP da estação de solo (aracua-bridge)"),
        DeclareLaunchArgument("cloud_topic", default_value="/lidar/points",
                              description="Tópico PointCloud2 do LiDAR"),
        Node(package="aracua_onboard", executable="voxel_mapper", name="voxel_mapper",
             parameters=[params, {"cloud_topic": cloud_topic}], output="screen"),
        Node(package="aracua_onboard", executable="obstacle_sectors", name="obstacle_sectors",
             parameters=[params, {"cloud_topic": cloud_topic}], output="screen"),
        Node(package="aracua_onboard", executable="map_link", name="map_link",
             parameters=[params, {"ground_host": ground_host}], output="screen"),
    ])
