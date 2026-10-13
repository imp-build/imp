local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local test = require("@imp/rules/workflows/test")
local cmake = require("@imp/rules/c/cmake")
local gcc = require("@imp/rules/c/gcc")
local msvc = require("@imp/rules/c/msvc")
local zig = require("@imp/rules/c/zig")
local c = require("@imp/rules/c")

local BUILD = build.BUILD
local PACKAGE = package.PACKAGE
local TEST = test.TEST

local is_windows = core.platform_info().os == "windows"

-- gcc, not zig: cmake_project() supports only gcc and MSVC. raw_hello and
-- raw_main below use zig, which cc_library() and cc_binary() support.
local hello = cmake.cmake_project({
	path = "rules/c/cmake/example",
	cmake_args = { "-DCMAKE_BUILD_TYPE=Debug" },
})

local zig_toolchain = zig.graph_toolchain("0.16.0")

-- hello_cmake is an add_library(... SHARED ...) target, so it goes in the
-- shared list. The caller must say so: the CMake target type is not known
-- at declaration time.
local hello_cmake_lib = cmake.cmake_library_dep(hello, "hello_cmake", {
	include_dirs = { "rules/c/cmake/example" },
	shared = true,
})

local targets = {
	hello_cmake = {
		[BUILD] = hello:get("hello_cmake", BUILD),
		[PACKAGE] = hello:get("hello_cmake", PACKAGE),
	},
	hello_cmake_main = {
		[BUILD] = hello:get("hello_cmake_main", BUILD),
		[TEST] = hello:get("hello_cmake_main", TEST, "unit"),
	},
	-- Issue #98: the archive edge of a STATIC_LIBRARY target needs ranlib.
	hello_cmake_static_main = {
		[BUILD] = hello:get("hello_cmake_static_main", BUILD),
		[TEST] = hello:get("hello_cmake_static_main", TEST, "unit"),
	},
	-- Issue #89: the replay of a C++ target runs the bare tool name "c++".
	hello_cmake_cxx_main = {
		[BUILD] = hello:get("hello_cmake_cxx_main", BUILD),
	},

	-- Issue #67: a raw cc_binary() that links a CMake target. It needs gcc
	-- explicitly, because hello_cmake is built with gcc.
	uses_cmake_lib = c.cc_binary({
		srcs = { "uses_cmake_lib.c" },
		deps = { hello_cmake_lib },
		toolchain = gcc.default_graph_toolchain(),
	}),
	-- The same consumer, run. Its product is a directory with the executable
	-- and libhello_cmake.so, linked with -Wl,-rpath,$ORIGIN. A clean exit
	-- shows that a workspace-built shared library loads at run time.
	-- uses_cmake_lib.c returns 0 only when hello_cmake_add(2, 3) == 5.
	uses_cmake_lib_test = c.cc_test({
		srcs = { "uses_cmake_lib.c" },
		deps = { hello_cmake_lib },
		toolchain = gcc.default_graph_toolchain(),
	}),
}

local raw_hello = c.cc_library({ srcs = { "hello.c" }, toolchain = zig_toolchain })
targets.raw_hello = raw_hello
targets.raw_main = c.cc_binary({ srcs = { "main.c" }, deps = { raw_hello }, toolchain = zig_toolchain })

-- MSVC as a cmake_project() toolchain, with its own build directory. Only on
-- Windows: the vswhere.exe discovery task of msvc_toolchain() has no
-- host-OS guard.
if is_windows then
	local hello_msvc = cmake.cmake_project({
		path = "rules/c/cmake/example",
		build_dir = "build/rules/c/cmake/example-msvc",
		cmake_args = { "-DCMAKE_BUILD_TYPE=Debug" },
		toolchain = msvc.msvc_toolchain(),
	})
	targets.hello_cmake_msvc_main = { [BUILD] = hello_msvc:get("hello_cmake_main", BUILD) }
	targets.hello_cmake_msvc_cxx_main = { [BUILD] = hello_msvc:get("hello_cmake_cxx_main", BUILD) }

	-- The commands() of msvc_toolchain() through raw cc_library() and
	-- cc_binary().
	local raw_hello_msvc = c.cc_library({ srcs = { "hello.c" }, toolchain = msvc.msvc_toolchain() })
	targets.raw_hello_msvc = raw_hello_msvc
	targets.raw_main_msvc = c.cc_binary({
		srcs = { "main.c" },
		deps = { raw_hello_msvc },
		toolchain = msvc.msvc_toolchain(),
	})
end

return targets
