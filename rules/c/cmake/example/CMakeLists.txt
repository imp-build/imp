cmake_minimum_required(VERSION 3.20)
project(hello_cmake C CXX)

add_library(hello_cmake SHARED hello.c)

# Issue #89: a C++ target exercises the GCC graph toolchain's `c++` driver,
# not just `cc`/`clang`.
add_executable(hello_cmake_cxx_main hello_cxx.cpp main_cxx.cpp)

add_custom_command(TARGET hello_cmake POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:hello_cmake>
        "${CMAKE_CURRENT_SOURCE_DIR}/$<TARGET_FILE_NAME:hello_cmake>"
    COMMENT "Copying hello_cmake artifact to project root")

add_executable(hello_cmake_main main.c)
target_link_libraries(hello_cmake_main PRIVATE hello_cmake)

# Issue #98: a STATIC_LIBRARY target's archive edge runs `ar` then `ranlib`
# (a SHARED_LIBRARY, like hello_cmake above, never invokes ranlib) — this is
# the only target in this fixture that exercises that edge.
add_library(hello_cmake_static STATIC hello.c)

add_executable(hello_cmake_static_main main.c)
target_link_libraries(hello_cmake_static_main PRIVATE hello_cmake_static)

enable_testing()
add_test(NAME hello_cmake_main_test COMMAND hello_cmake_main)
add_test(NAME hello_cmake_static_main_test COMMAND hello_cmake_static_main)
