cmake_minimum_required(VERSION 3.16)
project(aracua_onboard LANGUAGES CXX)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(geographic_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(std_srvs REQUIRED)

set(deps rclcpp sensor_msgs geometry_msgs geographic_msgs std_msgs std_srvs)

foreach(node voxel_mapper obstacle_sectors map_link sim_lidar)
  add_executable(${node} src/${node}_node.cpp)
  target_include_directories(${node} PRIVATE include)
  ament_target_dependencies(${node} ${deps})
  install(TARGETS ${node} DESTINATION lib/${PROJECT_NAME})
endforeach()

install(DIRECTORY include/ DESTINATION include)
install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_core test/test_core.cpp)
  target_include_directories(test_core PRIVATE include)
  # Quadros de referência compartilhados com a ponte e a interface (docs/fixtures).
  get_filename_component(ARACUA_FIXTURES "${CMAKE_CURRENT_SOURCE_DIR}/../../../docs/fixtures" ABSOLUTE)
  target_compile_definitions(test_core PRIVATE ARACUA_FIXTURES="${ARACUA_FIXTURES}")
endif()

ament_package()
