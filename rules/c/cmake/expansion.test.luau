-- Tests of CMake discovery, scan, and replay.
--
-- The fixture has the shape of rules/c/cmake/example/CMakeLists.txt: a
-- SHARED_LIBRARY (hello_cmake), an EXECUTABLE (hello_cmake_main) that links
-- it, and one add_test() for the executable.
--
-- A faked action gives placeholder artifacts with no CAS content, so a test
-- cannot resolve the configure or scan task, or the expansion that reads
-- their values. The tests thus examine the pure steps (`configured_graph`,
-- `scan_manifest`, `plan_replay`, and the discovery passes) on fixture text,
-- and resolve replay and ctest tasks with a fixture graph value. A real
-- CMake project covers the full chain: `imp build` and `imp test` of
-- //rules/c/cmake/example.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local test_workflow = require("@imp/rules/workflows/test")
local gcc = require("@imp/rules/c/gcc")
local expansion = require("@imp/rules/c/cmake/expansion")
local replay = require("@imp/rules/c/cmake/graph_replay")
local ninja = require("@imp/rules/c/cmake/ninja_graph")

local BUILD = build.BUILD
local PACKAGE = package.PACKAGE
local TEST = test_workflow.TEST

local SANDBOX_ROOT = "/sandbox-7-3-1"
local PROJECT = "rules/c/cmake/example"
-- The default build directory of `cmake_project_spec` for PROJECT.
local BUILD_DIR = "build/rules/c/cmake/example"

local function with_root(text)
	text = ninja.replace_all(text, "@ROOT@", SANDBOX_ROOT)
	return ninja.replace_all(text, "@BUILD_DIR@", BUILD_DIR)
end

local RULES_NINJA = with_root([[
rule C_COMPILER__hello_cmake_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = /usr/bin/cc $DEFINES $INCLUDES $FLAGS -o $out -c $in
  description = Building C object $out

rule C_SHARED_LIBRARY_LINKER__hello_cmake_
  command = /usr/bin/cc -shared $in -o $TARGET_FILE
  description = Linking C shared library $TARGET_FILE

rule C_COMPILER__hello_cmake_main_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = /usr/bin/cc $DEFINES $INCLUDES $FLAGS -o $out -c $in
  description = Building C object $out

rule C_EXECUTABLE_LINKER__hello_cmake_main_
  command = /usr/bin/cc $in -o $TARGET_FILE $LINK_LIBRARIES
  description = Linking C executable $TARGET_FILE

rule RERUN_CMAKE
  command = /usr/bin/cmake --regenerate-during-build -S@ROOT@ -B@ROOT@/build
  generator = 1
]])

local BUILD_NINJA = with_root([[
ninja_required_version = 1.5

include CMakeFiles/rules.ninja

cmake_ninja_workdir = @ROOT@/@BUILD_DIR@/

# Object build statements for SHARED_LIBRARY target hello_cmake
build CMakeFiles/hello_cmake.dir/hello.c.o: C_COMPILER__hello_cmake_unscanned_ @ROOT@/rules/c/cmake/example/hello.c
  DEP_FILE = CMakeFiles/hello_cmake.dir/hello.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

# Link build statements for SHARED_LIBRARY target hello_cmake
build libhello_cmake.so: C_SHARED_LIBRARY_LINKER__hello_cmake_ CMakeFiles/hello_cmake.dir/hello.c.o
  TARGET_FILE = libhello_cmake.so

build hello_cmake: phony libhello_cmake.so

# Object build statements for EXECUTABLE target hello_cmake_main
build CMakeFiles/hello_cmake_main.dir/main.c.o: C_COMPILER__hello_cmake_main_unscanned_ @ROOT@/rules/c/cmake/example/main.c
  DEP_FILE = CMakeFiles/hello_cmake_main.dir/main.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake_main.dir

# Link build statements for EXECUTABLE target hello_cmake_main
build hello_cmake_main: C_EXECUTABLE_LINKER__hello_cmake_main_ CMakeFiles/hello_cmake_main.dir/main.c.o | libhello_cmake.so
  TARGET_FILE = hello_cmake_main
  LINK_LIBRARIES = libhello_cmake.so

build all: phony libhello_cmake.so hello_cmake_main

build build.ninja: RERUN_CMAKE @ROOT@/CMakeLists.txt
]])

local CTEST_TESTFILE = with_root([==[# CMake generated Testfile for
# Source directory: @ROOT@
# Build directory: @ROOT@/@BUILD_DIR@
add_test([=[hello_cmake_main_test]=] "@ROOT@/@BUILD_DIR@/hello_cmake_main")
subdirs("tests")
]==])

local NESTED_CTEST_TESTFILE = with_root([==[
add_test([=[nested_test]=] "@ROOT@/@BUILD_DIR@/tests/nested")
subdirs("@ROOT@/@BUILD_DIR@/tests/deeper")
]==])

local DEEPER_CTEST_TESTFILE = "add_test(deeper_test deeper)\n"

local GENERATED = {
	["build.ninja"] = BUILD_NINJA,
	["CMakeFiles/rules.ninja"] = RULES_NINJA,
	["CTestTestfile.cmake"] = CTEST_TESTFILE,
	["tests/CTestTestfile.cmake"] = NESTED_CTEST_TESTFILE,
	["tests/deeper/CTestTestfile.cmake"] = DEEPER_CTEST_TESTFILE,
}

local function read_generated(path)
	local text = GENERATED[path]
	if text == nil then
		error(`no generated file {path}`)
	end
	return text
end

local function fixture_graph()
	local graph = replay.configured_graph(read_generated, BUILD_DIR)
	return graph
end

local SOURCE_PATHS = {
	"rules/c/cmake/example/hello.c",
	"rules/c/cmake/example/hello.h",
	"rules/c/cmake/example/main.c",
}

local HELLO_OBJ = "CMakeFiles/hello_cmake.dir/hello.c.o"
local MAIN_OBJ = "CMakeFiles/hello_cmake_main.dir/main.c.o"

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function same_list(actual, expected)
	if #actual ~= #expected then
		return false
	end
	for i, value in ipairs(expected) do
		if actual[i] ~= value then
			return false
		end
	end
	return true
end

local function edge_with_output(edges, path)
	for _, edge in ipairs(edges) do
		if table.find(edge.outputs, path) then
			return edge
		end
	end
	return nil
end

local function run_with(host, display)
	for _, run in ipairs(host.runs) do
		if run.display == display then
			return run
		end
	end
	error(`no run has the display '{display}'`)
end

local function fake_gcc()
	return gcc.toolchain_record(core.native_tool("gcc-toolchain"), "2025.08-1")
end

local function fake_spec(options)
	options = options or {}
	options.path = PROJECT
	options.toolchain = fake_gcc()
	options.cmake_toolchain = { tool = core.native_tool("cmake"), version = "4.4.3" }
	return replay.cmake_project_spec(options)
end

-- A stand-in for the configure task: its `directory` output is a faked
-- action placeholder.
local function fake_configured()
	return core.task({
		outputs = { directory = core.output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = { "sh", "-c", "true" },
				outputs = { directory = core.output.directory(BUILD_DIR) },
				display = "fake configure",
			})
			return { directory = result.outputs.directory }
		end,
	})
end

local SCAN_DEPS = table.concat({
	"CMakeFiles/hello_cmake.dir/hello.c.o: #deps 2, deps mtime 0 (STALE)",
	"    ../../../../../rules/c/cmake/example/hello.c",
	"    ../../../../../rules/c/cmake/example/hello.h",
	"",
	"CMakeFiles/hello_cmake_main.dir/main.c.o: #deps 1, deps mtime 0 (STALE)",
	"    ../../../../../rules/c/cmake/example/main.c",
}, "\n")

-- The Windows variant: hello_cmake is a DLL with an import library, and the
-- executable references both, `| libhello_cmake.dll.a || libhello_cmake.dll`.
local WINDOWS_RULES = [[
rule C_COMPILER__hello_cmake_unscanned_
  command = cc -c $in -o $out

rule C_SHARED_LIBRARY_LINKER__hello_cmake_
  command = cc -shared -o $TARGET_FILE $in

rule C_COMPILER__hello_cmake_main_unscanned_
  command = cc -c $in -o $out

rule C_EXECUTABLE_LINKER__hello_cmake_main_
  command = cc $in -o $TARGET_FILE -lhello_cmake
]]

local WINDOWS_BUILD = [[
include CMakeFiles/rules.ninja

# Object build statements for SHARED_LIBRARY target hello_cmake
build CMakeFiles/hello_cmake.dir/hello.c.o: C_COMPILER__hello_cmake_unscanned_ hello.c
  DEP_FILE = CMakeFiles/hello_cmake.dir/hello.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

# Link build statements for SHARED_LIBRARY target hello_cmake
build libhello_cmake.dll libhello_cmake.dll.a: C_SHARED_LIBRARY_LINKER__hello_cmake_ CMakeFiles/hello_cmake.dir/hello.c.o
  TARGET_FILE = libhello_cmake.dll
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

build hello_cmake: phony libhello_cmake.dll

# Object build statements for EXECUTABLE target hello_cmake_main
build CMakeFiles/hello_cmake_main.dir/main.c.o: C_COMPILER__hello_cmake_main_unscanned_ main.c
  DEP_FILE = CMakeFiles/hello_cmake_main.dir/main.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake_main.dir

# Link build statements for EXECUTABLE target hello_cmake_main
build hello_cmake_main.exe: C_EXECUTABLE_LINKER__hello_cmake_main_ CMakeFiles/hello_cmake_main.dir/main.c.o | libhello_cmake.dll.a || libhello_cmake.dll
  TARGET_FILE = hello_cmake_main.exe

build hello_cmake_main: phony hello_cmake_main.exe

build all: phony libhello_cmake.dll hello_cmake_main
]]

return {
	core.test.suite("configured graph", {
		core.test.case("parses the build files and rebases the sandbox root", function()
			local graph = fixture_graph()
			assert(graph.sandbox_root == SANDBOX_ROOT, tostring(graph.sandbox_root))
			assert(graph.rules.RERUN_CMAKE ~= nil)
			assert(edge_with_output(graph.edges, HELLO_OBJ) ~= nil)
		end),

		core.test.case("removes the configure build directory from the ctest text", function()
			local graph = fixture_graph()
			assert(not contains(graph.ctest_text, `{SANDBOX_ROOT}/{BUILD_DIR}/`), graph.ctest_text)
			assert(contains(graph.ctest_text, '"hello_cmake_main"'), graph.ctest_text)
		end),

		core.test.case("finds nested CTestTestfile.cmake files through subdirs()", function()
			local _, ctest_paths = replay.configured_graph(read_generated, BUILD_DIR)
			assert(same_list(ctest_paths, {
				`{BUILD_DIR}/CTestTestfile.cmake`,
				`{BUILD_DIR}/tests/CTestTestfile.cmake`,
				`{BUILD_DIR}/tests/deeper/CTestTestfile.cmake`,
			}))
		end),

		core.test.case("has no ctest text when the project has no tests", function()
			local graph, ctest_paths = replay.configured_graph(function(path)
				if path == "CTestTestfile.cmake" then
					error("missing")
				end
				return read_generated(path)
			end, BUILD_DIR)
			assert(graph.ctest_text == nil)
			assert(#ctest_paths == 0)
		end),
	}),

	core.test.suite("compiler inputs", {
		core.test.case("compiler edges select their direct source while other edges stay broad", function()
			local graph = fixture_graph()
			local compiler = edge_with_output(graph.edges, HELLO_OBJ)
			local linker = edge_with_output(graph.edges, "libhello_cmake.so")
			local sources = table.clone(SOURCE_PATHS)
			table.insert(sources, "rules/c/cmake/example/unrelated.json")
			assert(replay.is_cmake_compiler_edge(compiler, graph.rules))
			assert(not replay.is_cmake_compiler_edge(linker, graph.rules))
			assert(same_list(
				replay.compiler_workspace_sources(compiler, graph.rules, SANDBOX_ROOT, sources),
				{ "rules/c/cmake/example/hello.c" }
			))
			assert(#replay.compiler_workspace_sources(linker, graph.rules, SANDBOX_ROOT, sources) == 0)
		end),

		core.test.case("recognizes Ninja's MSVC dependency mode", function()
			assert(replay.is_cmake_compiler_edge({ rule = "CXX_COMPILER__app" }, { CXX_COMPILER__app = { deps = "msvc" } }))
		end),

		core.test.case("linker dependency mode does not make it a compiler edge", function()
			local rules = { C_EXECUTABLE_LINKER__app = { deps = "gcc" } }
			assert(not replay.is_cmake_compiler_edge({ rule = "C_EXECUTABLE_LINKER__app" }, rules))
		end),

		core.test.case("parses Ninja dependency records", function()
			local deps = replay.parse_ninja_deps(table.concat({
				"CMakeFiles/app.dir/main.c.obj: #deps 3, deps mtime 0 (STALE)",
				"    ../../main.c",
				"    ../../main.h",
				"    C:\\SDK\\include\\stdio.h",
				"",
			}, "\n"))
			assert(same_list(deps["CMakeFiles/app.dir/main.c.obj"], { "../../main.c", "../../main.h", "C:/SDK/include/stdio.h" }))
		end),

		core.test.case("scan_manifest returns exact workspace headers", function()
			local manifest = replay.scan_manifest(fixture_graph(), SOURCE_PATHS, BUILD_DIR, SCAN_DEPS)
			assert(manifest[HELLO_OBJ].fallback == nil)
			assert(same_list(manifest[HELLO_OBJ].headers, { "rules/c/cmake/example/hello.h" }))
			assert(manifest[MAIN_OBJ].fallback == nil)
			assert(#manifest[MAIN_OBJ].headers == 0)
			-- Only compiler edges have an entry.
			assert(manifest["libhello_cmake.so"] == nil)
		end),

		core.test.case("scan_manifest rejects a missing Ninja record", function()
			local text = error_text(replay.scan_manifest, fixture_graph(), SOURCE_PATHS, BUILD_DIR, "")
			assert(contains(text, HELLO_OBJ), text)
			assert(contains(text, "Ninja did not report compiler dependencies"), text)
		end),

		core.test.case("scan_manifest rejects a record that omits the direct source", function()
			local deps = "CMakeFiles/hello_cmake.dir/hello.c.o: #deps 1, deps mtime 0 (STALE)\n"
				.. "    ../../../../../rules/c/cmake/example/hello.h\n"
			local text = error_text(replay.scan_manifest, fixture_graph(), SOURCE_PATHS, BUILD_DIR, deps)
			assert(contains(text, HELLO_OBJ), text)
			assert(contains(text, "Ninja dependency record omitted the direct source"), text)
		end),
	}),

	core.test.suite("replay plan", {
		core.test.case("orders the edges of a target in dependency waves", function()
			local plan = replay.plan_replay(fake_spec(), fixture_graph(), { "hello_cmake_main" }, {}, SOURCE_PATHS, {})
			assert(#plan.waves == 3)
			-- Both objects, then the library, then the executable.
			assert(#plan.waves[1] == 2)
			assert(same_list(plan.waves[2][1].outputs, { "libhello_cmake.so" }))
			assert(same_list(plan.waves[3][1].outputs, { "hello_cmake_main" }))
		end),

		core.test.case("stops at a dependency target's outputs", function()
			local plan = replay.plan_replay(fake_spec(), fixture_graph(), { "hello_cmake_main" }, {
				hello_cmake = { outputs = { "libhello_cmake.so" } },
			}, SOURCE_PATHS, {})
			assert(#plan.waves == 2)
			assert(same_list(plan.waves[1][1].outputs, { MAIN_OBJ }))
			assert(same_list(plan.source_paths, { "rules/c/cmake/example/main.c" }))
		end),

		core.test.case("uses the scanned headers, or every include-like source as a fallback", function()
			local graph = fixture_graph()
			local scanned = replay.plan_replay(fake_spec(), graph, { "hello_cmake" }, {}, SOURCE_PATHS, {
				[HELLO_OBJ] = { headers = { "rules/c/cmake/example/hello.h" } },
			})
			assert(scanned.compiler_input_plan[HELLO_OBJ].fallback == nil)
			assert(same_list(scanned.header_paths, { "rules/c/cmake/example/hello.h" }))

			local fallback = replay.plan_replay(fake_spec(), graph, { "hello_cmake" }, {}, SOURCE_PATHS, {})
			assert(fallback.compiler_input_plan[HELLO_OBJ].fallback == "no scan manifest")
			assert(same_list(fallback.header_paths, { "rules/c/cmake/example/hello.h" }))
		end),

		core.test.case("rejects a selected CMake module edge", function()
			local graph = fixture_graph()
			edge_with_output(graph.edges, HELLO_OBJ).vars.dyndep = "CMakeFiles/hello_cmake.dir/CXX.dd"
			local message = error_text(replay.plan_replay, fake_spec(), graph, { "hello_cmake" }, {}, SOURCE_PATHS, {})
			assert(contains(message, "does not support modules yet"), message)
		end),
	}),

	core.test.suite("replay task", {
		core.test.case("compiler replay mounts its source and headers, not the full source set", function()
			core.test.with_fake_toolchain_host(function(host)
				local spec = fake_spec()
				local task = replay.replay_cmake_target(
					spec,
					fake_configured(),
					fixture_graph(),
					{ "hello_cmake" },
					{ "libhello_cmake.so" },
					{},
					SOURCE_PATHS,
					replay.scan_manifest(fixture_graph(), SOURCE_PATHS, BUILD_DIR, SCAN_DEPS)
				)
				core.test.resolve(task)
				local compile = run_with(host, `cmake edge {HELLO_OBJ}`)
				-- The source, its header, and the configured directory.
				assert(compile.input_count == 3, tostring(compile.input_count))
				assert(compile.argv[1] == "sh" and compile.argv[2] == "-c")
				assert(
					compile.argv[3]
						== `cd '{BUILD_DIR}' && cc    -o {HELLO_OBJ} -c ../../../../../rules/c/cmake/example/hello.c`,
					compile.argv[3]
				)
				assert(compile.outputs.out1 == `{BUILD_DIR}/{HELLO_OBJ}`)
				-- The link edge gets the full source set, the configured
				-- directory, and the object.
				local link = run_with(host, "cmake edge libhello_cmake.so")
				assert(link.input_count == 3, tostring(link.input_count))
				local stage = run_with(host, `cmake stage {PROJECT}`)
				assert(stage.outputs.directory == BUILD_DIR)
				assert(stage.outputs.file1 == `{BUILD_DIR}/libhello_cmake.so`)
				assert(table.find(compile.tools, "cmake") and table.find(compile.tools, "gcc-toolchain"))
			end)
		end),

		core.test.case("shows a broad input fallback in the edge display", function()
			core.test.with_fake_toolchain_host(function(host)
				core.test.resolve(
					replay.replay_cmake_target(fake_spec(), fake_configured(), fixture_graph(), { "hello_cmake" }, {}, {}, SOURCE_PATHS, {})
				)
				run_with(host, `cmake edge {HELLO_OBJ} [broad input fallback: no scan manifest]`)
			end)
		end),

		core.test.case("takes each referenced output of a dependency target as an input", function()
			core.test.with_fake_toolchain_host(function(host)
				local spec = fake_spec()
				local configured = fake_configured()
				local graph = fixture_graph()
				local hello = replay.replay_cmake_target(spec, configured, graph, { "libhello_cmake.so" }, { "libhello_cmake.so" })
				local main = replay.replay_cmake_target(spec, configured, graph, { "hello_cmake_main" }, { "hello_cmake_main" }, {
					hello_cmake = { outputs = { "libhello_cmake.so" }, task = hello, file_indices = { 1 } },
				})
				core.test.resolve(main)
				-- main.c.o is not replayed again by the hello_cmake task.
				local main_link = run_with(host, "cmake edge hello_cmake_main")
				-- The full source set, the configured directory, the object, and
				-- the library of the dependency.
				assert(main_link.input_count == 4, tostring(main_link.input_count))
				local count = 0
				for _, run in ipairs(host.runs) do
					if string.sub(run.display, 1, #`cmake edge {HELLO_OBJ}`) == `cmake edge {HELLO_OBJ}` then
						count += 1
					end
				end
				assert(count == 1, `the dependency target replays its own edges once, not {count} times`)
			end)
		end),

		core.test.case("fails for an edge that runs an unknown absolute host tool", function()
			local graph = fixture_graph()
			graph.rules.C_SHARED_LIBRARY_LINKER__hello_cmake_ = { command = "/opt/odd/linker $in -o $TARGET_FILE" }
			core.test.with_fake_toolchain_host(function()
				local message = error_text(
					core.test.resolve,
					replay.replay_cmake_target(fake_spec(), fake_configured(), graph, { "hello_cmake" })
				)
				assert(contains(message, "cmake edge needs unsupported host tool 'linker'"), message)
			end)
		end),

		core.test.case("writes a response file through positional argv chunks", function()
			local graph = fixture_graph()
			graph.rules.C_SHARED_LIBRARY_LINKER__hello_cmake_ = {
				command = "/usr/bin/cc -shared @$RSP_FILE -o $TARGET_FILE",
				rspfile = "$RSP_FILE",
				rspfile_content = "$in",
			}
			edge_with_output(graph.edges, "libhello_cmake.so").vars.RSP_FILE = "CMakeFiles/hello.rsp"
			core.test.with_fake_toolchain_host(function(host)
				core.test.resolve(replay.replay_cmake_target(fake_spec(), fake_configured(), graph, { "hello_cmake" }))
				local link = run_with(host, "cmake edge libhello_cmake.so")
				assert(link.argv[4] == "cmake-rsp" and link.argv[5] == "CMakeFiles/hello.rsp")
				assert(link.argv[6] == HELLO_OBJ, tostring(link.argv[6]))
				assert(contains(link.argv[3], 'for chunk; do printf'), link.argv[3])
			end)
		end),
	}),

	core.test.suite("ctest task", {
		core.test.case("runs ctest for the correlated test names only", function()
			core.test.with_fake_toolchain_host(function(host)
				local units = core.test.resolve(replay.run_ctest_task(
					fake_spec(),
					fake_configured(),
					fixture_graph(),
					{ "hello_cmake_main" },
					{ "hello_cmake_main_test" }
				).outputs.units)
				local ctest = run_with(host, `ctest {PROJECT}`)
				assert(ctest.allow_failure == true)
				assert(same_list(ctest.argv, {
					"sh",
					"-c",
					'bdir=$1; shift; ctest --output-on-failure --test-dir "$bdir" "$@"',
					"cmake-ctest",
					BUILD_DIR,
					"-R",
					"^(hello_cmake_main_test)$",
				}))
				assert(#units == 1 and units[1].name == "hello_cmake_main_test" and units[1].ok)
			end)
		end),

		core.test.case("reports a failing ctest run as a failed unit", function()
			core.test.with_fake_toolchain_host(function(host)
				host.set_run_exit_code(`ctest {PROJECT}`, 8)
				host.set_run_stdout(`ctest {PROJECT}`, "1 test failed")
				local units = core.test.resolve(
					replay.run_ctest_task(fake_spec(), fake_configured(), fixture_graph(), { "hello_cmake_main" }).outputs.units
				)
				assert(units[1].name == PROJECT and not units[1].ok)
				assert(contains(units[1].output, "1 test failed"))
			end)
		end),

		core.test.case("escapes regex characters in test names", function()
			local args = replay.ctest_name_filter_args({ "a.b", "c+(d)" })
			assert(same_list(args, { "-R", "^(a\\.b|c\\+\\(d\\))$" }), args[2])
			assert(#replay.ctest_name_filter_args({}) == 0)
		end),
	}),

	core.test.suite("discovery", {
		core.test.case("only hello_cmake_main's executable target correlates to the add_test() entry", function()
			local graph = fixture_graph()
			local tests = replay.correlate_ctest_entries(graph)
			assert(same_list(tests.hello_cmake_main, { "hello_cmake_main_test" }))
			local named = ninja.list_named_cmake_targets(graph)
			assert(named[1].name == "hello_cmake" and named[1].type == "SHARED_LIBRARY")
			assert(named[2].name == "hello_cmake_main" and named[2].type == "EXECUTABLE")
		end),

		core.test.case("cross_target_dependencies finds hello_cmake_main depends on hello_cmake, not the reverse", function()
			local graph = fixture_graph()
			local named = ninja.list_named_cmake_targets(graph)
			local cross = expansion.cross_target_dependencies(named, graph)
			assert(#cross.hello_cmake_main == 1)
			assert(cross.hello_cmake_main[1].name == "hello_cmake")
			assert(same_list(cross.hello_cmake_main[1].output_paths, { "libhello_cmake.so" }))
			assert(#cross.hello_cmake == 0)
		end),

		core.test.case("topo_sort_targets orders hello_cmake before hello_cmake_main", function()
			local graph = fixture_graph()
			local named = ninja.list_named_cmake_targets(graph)
			local reversed = { named[2], named[1] }
			local ordered = expansion.topo_sort_targets(reversed, expansion.cross_target_dependencies(named, graph))
			assert(ordered[1].name == "hello_cmake" and ordered[2].name == "hello_cmake_main")
		end),

		core.test.case("topo_sort_targets fails for a cycle", function()
			local named = { { name = "a", outputs = {} }, { name = "b", outputs = {} } }
			local cross = { a = { { name = "b" } }, b = { { name = "a" } } }
			local message = error_text(expansion.topo_sort_targets, named, cross)
			assert(contains(message, "cyclic target dependency detected among a, b"), message)
		end),

		core.test.case("build_target_deps mounts every one of a dependency's referenced outputs, not just one", function()
			local graph = ninja.parse_ninja(WINDOWS_BUILD, function()
				return WINDOWS_RULES
			end)
			local named = ninja.list_named_cmake_targets(graph)
			local cross = expansion.cross_target_dependencies(named, graph)
			assert(same_list(cross.hello_cmake_main[1].output_paths, { "libhello_cmake.dll", "libhello_cmake.dll.a" }))
			local deps = expansion.build_target_deps("hello_cmake_main", named, cross, { hello_cmake = "FAKE_TASK" })
			assert(same_list(deps.hello_cmake.file_indices, { 1, 2 }))
			assert(same_list(deps.hello_cmake.outputs, { "libhello_cmake.dll", "libhello_cmake.dll.a" }))
			assert(deps.hello_cmake.task == "FAKE_TASK")
		end),

		core.test.case("cmake_project records its spec and returns an expansion", function()
			local before = #expansion.cmake_project_specs()
			local project = expansion.cmake_project({
				path = PROJECT,
				toolchain = fake_gcc(),
				cmake_toolchain = { tool = core.native_tool("cmake"), version = "4.4.3" },
			})
			local specs = expansion.cmake_project_specs()
			assert(#specs == before + 1)
			assert(specs[#specs].path == PROJECT and specs[#specs].build_dir_path == BUILD_DIR)
			assert(type(project:get("hello_cmake", BUILD)) == "userdata")
			assert(type(project:get("hello_cmake_main", TEST, "unit")) == "userdata")
			assert(type(project:all(PACKAGE)) == "userdata")
		end),

		core.test.case("cmake_project rejects a zig toolchain", function()
			local message = error_text(replay.cmake_project_spec, {
				path = PROJECT,
				toolchain = { kind = "zig" },
				cmake_toolchain = { tool = core.native_tool("cmake"), version = "4.4.3" },
			})
			assert(contains(message, "doesn't support a zig toolchain"), message)
		end),
	}),

	core.test.suite("cmake_library_dep", {
		core.test.case("wraps a discovered target's BUILD handle as a cc_library-shaped deps entry", function()
			local project = expansion.cmake_project({
				path = PROJECT,
				toolchain = fake_gcc(),
				cmake_toolchain = { tool = core.native_tool("cmake"), version = "4.4.3" },
			})
			local dep = expansion.cmake_library_dep(project, "hello_cmake", { include_dirs = { PROJECT } })
			assert(type(dep[BUILD]) == "userdata")
			assert(rawequal(dep.archive, dep[BUILD]))
			assert(#dep.transitive_archives == 1 and rawequal(dep.transitive_archives[1], dep.archive))
			assert(#dep.transitive_shared_libs == 0)
			assert(same_list(dep.transitive_include_dirs, { PROJECT }))
			assert(#dep.transitive_linkopts == 0)
			assert(#dep.transitive_import_libs == 0 and #dep.transitive_hdrs == 0)
		end),

		core.test.case("routes a shared target to transitive_shared_libs, keeping it out of the archives", function()
			local project = expansion.cmake_project({
				path = PROJECT,
				toolchain = fake_gcc(),
				cmake_toolchain = { tool = core.native_tool("cmake"), version = "4.4.3" },
			})
			local dep = expansion.cmake_library_dep(project, "hello_cmake", {
				shared = true,
				linkopts = { "-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1" },
			})
			assert(#dep.transitive_shared_libs == 1 and rawequal(dep.transitive_shared_libs[1], dep.archive))
			assert(#dep.transitive_archives == 0)
			assert(same_list(dep.transitive_linkopts, { "-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1" }))
			assert(#dep.transitive_include_dirs == 0)
		end),
	}),
}
