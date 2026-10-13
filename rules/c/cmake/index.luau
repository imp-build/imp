-- The CMake rules. `cmake_project()` declares one expansion for each project,
-- with one child for each discovered CMake target (see ./expansion).
-- `cmake_library_dep()` adapts a discovered target as a `deps` entry of
-- `cc_library` or `cc_binary`. The CMake toolchain is in ./toolchain. The
-- configure, replay, Ninja, and CTest modules are internal.
local expansion = require("./expansion")
local toolchain = require("./toolchain")

return {
	cmake_library_dep = expansion.cmake_library_dep,
	cmake_project = expansion.cmake_project,
	cmake_project_expansion = expansion.cmake_project_expansion,
	cmake_project_specs = expansion.cmake_project_specs,
	cmake_toolchain = toolchain.cmake_toolchain,
	default_graph_toolchain = toolchain.default_graph_toolchain,
	graph_toolchain = toolchain.graph_toolchain,
}
