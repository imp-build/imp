cmake_minimum_required(VERSION 3.20)
project(hello_cmake C)

add_library(hello_cmake SHARED hello.c)

add_custom_command(TARGET hello_cmake POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:hello_cmake>
        "${CMAKE_CURRENT_SOURCE_DIR}/$<TARGET_FILE_NAME:hello_cmake>"
    COMMENT "Copying hello_cmake artifact to project root")
