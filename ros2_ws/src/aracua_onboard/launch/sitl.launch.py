"""Teste completo com o SITL do ArduPilot, sem hardware.

1. Em outro terminal, inicie o SITL enviando MAVLink para a ponte e para o MAVROS:
       sim_vehicle.py -v ArduCopter --out udp:127.0.0.1:14550 --out udp:127.0.0.1:14555
2. Inicie este launch:
       ros2 launch aracua_onboard sitl.launch.py
3. Inicie a ponte (bridge/) e a interface (gcs-web/).

Sobe o MAVROS, o LiDAR simulado e os nós de bordo.
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import AnyLaunchDescriptionSource, PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    share = FindPackageShare("aracua_onboard")
    params = PathJoinSubstitution([share, "config", "onboard.yaml"])

    mavros = IncludeLaunchDescription(
        AnyLaunchDescriptionSource(PathJoinSubstitution([FindPackageShare("mavros"), "launch", "apm.launch"])),
        launch_arguments={
            "fcu_url": LaunchConfiguration("fcu_url"),
            "gcs_url": "",
            "tgt_system": "1",
        }.items(),
    )

    onboard = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution([share, "launch", "onboard.launch.py"])),
        launch_arguments={"ground_host": LaunchConfiguration("ground_host")}.items(),
    )

    return LaunchDescription([
        DeclareLaunchArgument("fcu_url", default_value="udp://:14555@",
                              description="Conexão do MAVROS com o SITL"),
        DeclareLaunchArgument("ground_host", default_value="127.0.0.1"),
        mavros,
        Node(package="aracua_onboard", executable="sim_lidar", name="sim_lidar",
             parameters=[params], output="screen"),
        onboard,
    ])
