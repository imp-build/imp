-- Tests of the Ninja graph parser.
--
-- The fixture has the shape of a real `cmake -S . -B build -G Ninja` probe
-- of a project with one static library (core), one executable (app) that
-- links it, and a ctest suite. Only the edges that matter remain, and a
-- made-up sandbox root makes the rebase steps deterministic.
local core = require("@imp/core")
local ninja = require("@imp/rules/c/cmake/ninja_graph")

local SANDBOX_ROOT = "/sandbox-42-999-1"

local function with_root(text)
	return ninja.replace_all(text, "@ROOT@", SANDBOX_ROOT)
end

local RULES_NINJA = with_root([[
rule C_COMPILER__core_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = ${LAUNCHER}${CODE_CHECK}/usr/bin/cc $DEFINES $INCLUDES $FLAGS -MD -MT $out -MF $DEP_FILE -o $out -c $in
  description = Building C object $out

rule C_STATIC_LIBRARY_LINKER__core_
  command = $PRE_LINK && /usr/bin/cmake -E rm -f $TARGET_FILE && /usr/bin/ar qc $TARGET_FILE $LINK_FLAGS $in && /usr/bin/ranlib $TARGET_FILE && $POST_BUILD
  description = Linking C static library $TARGET_FILE

rule C_COMPILER__app_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = ${LAUNCHER}${CODE_CHECK}/usr/bin/cc $DEFINES $INCLUDES $FLAGS -MD -MT $out -MF $DEP_FILE -o $out -c $in
  description = Building C object $out

rule C_EXECUTABLE_LINKER__app_
  command = $PRE_LINK && /usr/bin/cc $FLAGS $LINK_FLAGS $in -o $TARGET_FILE $LINK_PATH $LINK_LIBRARIES && $POST_BUILD
  description = Linking C executable $TARGET_FILE

rule CUSTOM_COMMAND
  command = $COMMAND
  description = $DESC

rule RERUN_CMAKE
  command = /usr/bin/cmake --regenerate-during-build -S@ROOT@ -B@ROOT@/build
  description = Re-running CMake...
  generator = 1

rule CLEAN
  command = /usr/bin/ninja -t clean

rule HELP
  command = /usr/bin/ninja -t targets
]])

local BUILD_NINJA = with_root([[
ninja_required_version = 1.5

include CMakeFiles/rules.ninja

cmake_ninja_workdir = @ROOT@/build/

# Object build statements for STATIC_LIBRARY target core
build CMakeFiles/core.dir/src/core.c.o: C_COMPILER__core_unscanned_ @ROOT@/src/core.c
  DEP_FILE = CMakeFiles/core.dir/src/core.c.o.d
  INCLUDES = -I@ROOT@/src
  OBJECT_DIR = CMakeFiles/core.dir

# Link build statements for STATIC_LIBRARY target core
build libcore.a: C_STATIC_LIBRARY_LINKER__core_ CMakeFiles/core.dir/src/core.c.o
  TARGET_FILE = libcore.a
  OBJECT_DIR = CMakeFiles/core.dir
  PRE_LINK = :
  POST_BUILD = :

# Object build statements for EXECUTABLE target app
build CMakeFiles/app.dir/src/main.c.o: C_COMPILER__app_unscanned_ @ROOT@/src/main.c
  DEP_FILE = CMakeFiles/app.dir/src/main.c.o.d
  INCLUDES = -I@ROOT@/src
  OBJECT_DIR = CMakeFiles/app.dir

# Link build statements for EXECUTABLE target app
build app: C_EXECUTABLE_LINKER__app_ CMakeFiles/app.dir/src/main.c.o | libcore.a
  TARGET_FILE = app
  LINK_LIBRARIES = libcore.a

build CMakeFiles/test.util: CUSTOM_COMMAND
  COMMAND = cd @ROOT@/build && /usr/bin/ctest --force-new-ctest-process
  DESC = Running tests...

build test: phony CMakeFiles/test.util

build CMakeFiles/edit_cache.util: CUSTOM_COMMAND
  COMMAND = cd @ROOT@/build && /usr/bin/cmake -E echo No dialog
  DESC = No interactive CMake dialog available...

build edit_cache: phony CMakeFiles/edit_cache.util

build CMakeFiles/rebuild_cache.util: CUSTOM_COMMAND
  COMMAND = cd @ROOT@/build && /usr/bin/cmake --regenerate-during-build

build rebuild_cache: phony CMakeFiles/rebuild_cache.util

build core: phony libcore.a

build all: phony libcore.a app

build build.ninja: RERUN_CMAKE @ROOT@/CMakeLists.txt

build clean: CLEAN

build help: HELP
]])

local function read_include(path)
	if path == "CMakeFiles/rules.ninja" then
		return RULES_NINJA
	end
	error(`unexpected include: {path}`)
end

local function parse()
	return ninja.parse_ninja(BUILD_NINJA, read_include)
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

local function sorted(values)
	local copy = table.clone(values)
	table.sort(copy)
	return copy
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function edge_with_output(edges, path)
	for _, edge in ipairs(edges) do
		if table.find(edge.outputs, path) then
			return edge
		end
	end
	return nil
end

local function first_output(edge)
	return edge.outputs[1] or edge.implicit_outputs[1]
end

local function without_phony(edges)
	local result = {}
	for _, edge in ipairs(edges) do
		if edge.rule ~= "phony" then
			table.insert(result, edge)
		end
	end
	return result
end

local function outputs_of(edges)
	local result = {}
	for _, edge in ipairs(edges) do
		table.insert(result, first_output(edge))
	end
	return result
end

local function root()
	return ninja.sandbox_root_from_workdir(parse().top_vars.cmake_ninja_workdir, "build")
end

-- A copy of `graph.rules` with the command of `rule_name` replaced.
local function with_rule(graph, rule_name, fields)
	local rules = table.clone(graph.rules)
	local rule = table.clone(rules[rule_name])
	for key, value in pairs(fields) do
		rule[key] = value
	end
	rules[rule_name] = rule
	return rules
end

local function with_vars(edge, vars)
	local copy = table.clone(edge)
	copy.vars = table.clone(edge.vars)
	for key, value in pairs(vars) do
		copy.vars[key] = value
	end
	return copy
end

return {
	core.test.suite("ninja_graph parser", {
		core.test.case("parses rules and build edges, following include", function()
			local graph = parse()
			local names = {}
			for name in pairs(graph.rules) do
				table.insert(names, name)
			end
			assert(same_list(
				sorted(names),
				sorted({
					"CLEAN",
					"CUSTOM_COMMAND",
					"C_COMPILER__app_unscanned_",
					"C_COMPILER__core_unscanned_",
					"C_EXECUTABLE_LINKER__app_",
					"C_STATIC_LIBRARY_LINKER__core_",
					"HELP",
					"RERUN_CMAKE",
				})
			))
			assert(graph.top_vars.cmake_ninja_workdir == `{SANDBOX_ROOT}/build/`)
			local core_obj = edge_with_output(graph.edges, "CMakeFiles/core.dir/src/core.c.o")
			assert(core_obj.rule == "C_COMPILER__core_unscanned_")
			assert(same_list(core_obj.inputs, { `{SANDBOX_ROOT}/src/core.c` }))
			assert(core_obj.vars.DEP_FILE == "CMakeFiles/core.dir/src/core.c.o.d")
		end),

		core.test.case("parses implicit and order-only dependency edges (|, ||)", function()
			local app_link = edge_with_output(parse().edges, "app")
			assert(same_list(app_link.inputs, { "CMakeFiles/app.dir/src/main.c.o" }))
			assert(same_list(app_link.implicit_inputs, { "libcore.a" }))
		end),

		-- CMake writes a literal colon as `$:`, for example the drive letter
		-- of a Windows path. Build-line outputs are relative to the build
		-- directory, so only top-level values and absolute inputs have one.
		core.test.case("unescapes Ninja's $: syntax in values and path tokens", function()
			local text = table.concat({
				"cmake_ninja_workdir = C$:/tmp/imp/sandbox-1/build/",
				"",
				"rule CUSTOM_COMMAND",
				"  command = $COMMAND",
				"",
				"build out.txt: CUSTOM_COMMAND C$:/src/a.txt",
				"  COMMAND = C$:/tools/echo.exe hi",
			}, "\n")
			local graph = ninja.parse_ninja(text, read_include)
			assert(graph.top_vars.cmake_ninja_workdir == "C:/tmp/imp/sandbox-1/build/")
			assert(same_list(graph.edges[1].inputs, { "C:/src/a.txt" }))
			assert(graph.edges[1].vars.COMMAND == "C:/tools/echo.exe hi")
		end),

		-- The Windows generator writes OBJECT_DIR, DEP_FILE, TARGET_FILE, and
		-- compiler paths with backslashes, which `sh -c` corrupts.
		core.test.case("normalizes backslashes to forward slashes in rule/edge values", function()
			local text = table.concat({
				"rule C_COMPILER__hello_unscanned_",
				"  command = C:\\tools\\clang.exe -MF $DEP_FILE -o $out -c $in",
				"",
				"build hello.o: C_COMPILER__hello_unscanned_ hello.c",
				"  DEP_FILE = CMakeFiles\\hello.dir\\hello.c.o.d",
				"  OBJECT_DIR = CMakeFiles\\hello.dir",
			}, "\n")
			local graph = ninja.parse_ninja(text, read_include)
			assert(
				graph.rules.C_COMPILER__hello_unscanned_.command == "C:/tools/clang.exe -MF $DEP_FILE -o $out -c $in"
			)
			assert(graph.edges[1].vars.DEP_FILE == "CMakeFiles/hello.dir/hello.c.o.d")
			assert(graph.edges[1].vars.OBJECT_DIR == "CMakeFiles/hello.dir")
		end),

		core.test.case("normalizes the backslashes of an MSVC include path", function()
			local graph = ninja.parse_ninja("include CMakeFiles\\rules.ninja\n", read_include)
			assert(graph.rules.CLEAN ~= nil)
		end),
	}),

	core.test.suite("ninja_graph reachability", {
		core.test.case("reaches only the real compile/link edges from 'all', in dependency order", function()
			local reached = without_phony(ninja.reachable_edges(parse().edges, { "all" }))
			assert(same_list(outputs_of(reached), {
				"CMakeFiles/core.dir/src/core.c.o",
				"libcore.a",
				"CMakeFiles/app.dir/src/main.c.o",
				"app",
			}))
		end),

		core.test.case("excludes CMake bookkeeping edges entirely", function()
			for _, edge in ipairs(ninja.reachable_edges(parse().edges, { "all" })) do
				assert(edge.rule ~= "RERUN_CMAKE" and edge.rule ~= "CLEAN")
				assert(edge.rule ~= "HELP" and edge.rule ~= "CUSTOM_COMMAND")
			end
		end),
	}),

	core.test.suite("ninja_graph bounded reachability", {
		core.test.case("excludes another named target's own edges once its boundary output is referenced", function()
			local reached = ninja.reachable_edges_bounded(parse().edges, { "app" }, { ["libcore.a"] = true })
			assert(same_list(outputs_of(without_phony(reached.edges)), { "CMakeFiles/app.dir/src/main.c.o", "app" }))
			assert(same_list(reached.boundaries, { "libcore.a" }))
		end),

		core.test.case("reports no boundary hit when the boundary path is never referenced", function()
			local edges = parse().edges
			local unbounded = ninja.reachable_edges_bounded(edges, { "app" }, {})
			local bounded = ninja.reachable_edges_bounded(edges, { "app" }, { ["some/other/target.a"] = true })
			assert(#bounded.boundaries == 0)
			assert(same_list(bounded.edges, unbounded.edges))
		end),

		-- A dependency on a target type that `list_named_cmake_targets`
		-- leaves out is never a boundary, so the walk goes through it.
		core.test.case(
			"walks through a dependency that isn't in the boundary set, exactly like reachable_edges",
			function()
				local edges = parse().edges
				local plain = without_phony(ninja.reachable_edges(edges, { "app" }))
				local bounded = without_phony(ninja.reachable_edges_bounded(edges, { "app" }, {}).edges)
				assert(same_list(bounded, plain))
			end
		),

		-- A Windows SHARED_LIBRARY dependency can show up as `| lib.dll.a ||
		-- lib.dll`: the link reads the import library, and the executable
		-- loads the DLL at run time. Both are boundaries.
		core.test.case(
			"reports both an implicit (|) and an order-only (||) reference to the same dependency",
			function()
				local text = table.concat({
					"rule LINK",
					"  command = cc $in -o $out -limpl",
					"",
					"build exe: LINK main.o | lib.dll.a || lib.dll",
				}, "\n")
				local edges = ninja.parse_ninja(text, read_include).edges
				local reached = ninja.reachable_edges_bounded(
					edges,
					{ "exe" },
					{ ["lib.dll.a"] = true, ["lib.dll"] = true }
				)
				assert(same_list(sorted(reached.boundaries), { "lib.dll", "lib.dll.a" }))
			end
		),
	}),

	core.test.suite("ninja_graph command resolution", {
		core.test.case("expands $in/$out and edge-scoped vars", function()
			local graph = parse()
			local core_obj = edge_with_output(graph.edges, "CMakeFiles/core.dir/src/core.c.o")
			local rule = graph.rules[core_obj.rule]
			local expanded = ninja.expand_var(rule.command, core_obj, graph.top_vars, rule)
			assert(contains(expanded, `-c {SANDBOX_ROOT}/src/core.c`), expanded)
			assert(contains(expanded, "-o CMakeFiles/core.dir/src/core.c.o"), expanded)
			assert(contains(expanded, `-I{SANDBOX_ROOT}/src`), expanded)
			assert(string.sub(expanded, 1, 12) == "/usr/bin/cc ", expanded)
		end),

		core.test.case("expands $in_newline with spaces", function()
			local edge = { inputs = { "a.o", "b.o" }, outputs = { "x" }, vars = {} }
			assert(ninja.expand_var("$in_newline ${out}", edge, {}, {}) == "a.o b.o x")
		end),

		core.test.case("rebases the configure sandbox's absolute root to workspace-relative", function()
			assert(root() == SANDBOX_ROOT)
			local rebased = ninja.rebase_absolute_paths(`-I{SANDBOX_ROOT}/src -c {SANDBOX_ROOT}/src/core.c`, root())
			assert(rebased == "-Isrc -c src/core.c", rebased)
			assert(ninja.sandbox_root_from_workdir("/x/other/", "build") == nil)
		end),

		core.test.case(
			"rewrites command-position absolute tool paths to bare names, leaves argument paths alone",
			function()
				local result = ninja.rewrite_tool_invocations(
					"/usr/bin/cc -Isrc -MD -MT out.o -MF out.o.d -o out.o -c /abs/src/core.c"
				)
				assert(
					result.command == "cc -Isrc -MD -MT out.o -MF out.o.d -o out.o -c /abs/src/core.c",
					result.command
				)
				assert(same_list(result.tool_names, { "cc" }))
			end
		),

		core.test.case("rewrites every chained invocation after && but not their arguments", function()
			local result = ninja.rewrite_tool_invocations(
				": && /usr/bin/cmake -E rm -f libcore.a && /usr/bin/ar qc libcore.a obj.o && /usr/bin/ranlib libcore.a && :"
			)
			assert(
				result.command == ": && cmake -E rm -f libcore.a && ar qc libcore.a obj.o && ranlib libcore.a && :",
				result.command
			)
			assert(same_list(sorted(result.tool_names), { "ar", "cmake", "ranlib" }))
		end),

		core.test.case("rewrites a tool after ;, ||, and (", function()
			local result = ninja.rewrite_tool_invocations("(/bin/a x);/bin/b || /bin/c")
			assert(result.command == "( a x); b || c", result.command)
			assert(same_list(result.tool_names, { "a", "b", "c" }))
		end),

		core.test.case(
			"resolve_edge_command combines expansion, rebasing (relative to build dir), and tool rewriting",
			function()
				local graph = parse()
				local core_obj = edge_with_output(graph.edges, "CMakeFiles/core.dir/src/core.c.o")
				-- Ninja runs commands in the build directory, so a rebased
				-- source path climbs out of "build" with one "../".
				local resolved = ninja.resolve_edge_command(core_obj, graph.rules, graph.top_vars, root(), "build")
				assert(contains(resolved.command, "cc "))
				assert(not contains(resolved.command, SANDBOX_ROOT))
				assert(contains(resolved.command, "-c ../src/core.c"), resolved.command)
				assert(same_list(resolved.tool_names, { "cc" }))
			end
		),

		-- A tool through the Imp mount is only on the PATH of its own mount,
		-- so it is never a tool name.
		core.test.case("resolve_edge_command rewrites imp's own relative tool-mount paths too", function()
			local graph = parse()
			local core_obj = edge_with_output(graph.edges, "CMakeFiles/core.dir/src/core.c.o")
			local command =
				ninja.replace_all(graph.rules[core_obj.rule].command, "/usr/bin/cc", ".imp/tools/zig/zig cc")
			local rules = with_rule(graph, core_obj.rule, { command = command })
			local resolved = ninja.resolve_edge_command(core_obj, rules, graph.top_vars, root(), "build")
			assert(contains(resolved.command, "zig cc "), resolved.command)
			assert(not contains(resolved.command, ".imp/tools"))
			assert(#resolved.tool_names == 0)
		end),

		-- CMake makes CMAKE_AR absolute at configure time, so a rebase gives
		-- "../.imp/tools/zig/zigar", which is still a tool invocation.
		core.test.case(
			"resolve_edge_command rewrites imp tool-mount paths even after CMake made them absolute",
			function()
				local graph = parse()
				local lib_edge = edge_with_output(graph.edges, "libcore.a")
				local command = ninja.replace_all(
					graph.rules[lib_edge.rule].command,
					"/usr/bin/ar",
					`{SANDBOX_ROOT}/.imp/tools/zig/zigar`
				)
				local rules = with_rule(graph, lib_edge.rule, { command = command })
				local resolved = ninja.resolve_edge_command(lib_edge, rules, graph.top_vars, root(), "build")
				assert(contains(resolved.command, "zigar qc"), resolved.command)
				assert(not contains(resolved.command, ".imp/tools/zig/zigar "))
				assert(not table.find(resolved.tool_names, "zigar"))
			end
		),

		core.test.case("resolve_edge_command handles the static-library link edge's multi-command chain", function()
			local graph = parse()
			local lib_edge = edge_with_output(graph.edges, "libcore.a")
			local resolved = ninja.resolve_edge_command(lib_edge, graph.rules, graph.top_vars, root(), "build")
			assert(
				resolved.command
					== ": && cmake -E rm -f libcore.a && ar qc libcore.a  CMakeFiles/core.dir/src/core.c.o && ranlib libcore.a && :",
				resolved.command
			)
			assert(same_list(sorted(resolved.tool_names), { "ar", "cmake", "ranlib" }))
		end),

		core.test.case("resolve_edge_command strips CMake's Windows cmd.exe /C wrapper", function()
			local graph = parse()
			local lib_edge = edge_with_output(graph.edges, "libcore.a")
			local rules = with_rule(graph, lib_edge.rule, {
				command = 'cmd.exe /C "cd . && C:/tools/cmake.exe -E rm -f $TARGET_FILE && '
					.. "C:/tools/ar.exe qc $TARGET_FILE $LINK_FLAGS $in && "
					.. 'C:/tools/ranlib.exe $TARGET_FILE && cd ."',
			})
			local resolved = ninja.resolve_edge_command(lib_edge, rules, graph.top_vars, root(), "build")
			assert(not contains(resolved.command, "cmd.exe"))
			assert(not contains(resolved.command, "C:/tools"))
			assert(
				resolved.command
					== "cd . && cmake.exe -E rm -f libcore.a && ar.exe qc libcore.a  CMakeFiles/core.dir/src/core.c.o && ranlib.exe libcore.a && cd .",
				resolved.command
			)
			assert(same_list(sorted(resolved.tool_names), { "ar.exe", "cmake.exe", "ranlib.exe" }))
		end),

		core.test.case("resolve_edge_command strips a mid-chain cmd.exe /C wrapper and its cd /D flag", function()
			local graph = parse()
			local lib_edge = edge_with_output(graph.edges, "libcore.a")
			local rules = with_rule(graph, lib_edge.rule, {
				command = "C:/tools/ar.exe qc $TARGET_FILE $LINK_FLAGS $in && "
					.. 'cmd.exe /C "cd /D ../out && C:/tools/cmake.exe -E copy a.dll b.dll"',
			})
			local resolved = ninja.resolve_edge_command(lib_edge, rules, graph.top_vars, root(), "build")
			assert(
				resolved.command
					== "ar.exe qc libcore.a  CMakeFiles/core.dir/src/core.c.o && cd ../out && cmake.exe -E copy a.dll b.dll",
				resolved.command
			)
			assert(same_list(sorted(resolved.tool_names), { "ar.exe", "cmake.exe" }))
		end),

		-- $POST_BUILD can be its own `cmd.exe /C "..."` inside the wrapper of
		-- the rule template. Each prefix and each quote goes, at any depth.
		core.test.case(
			"resolve_edge_command unwraps a cmd.exe /C wrapper nested inside another via $POST_BUILD",
			function()
				local graph = parse()
				local lib_edge = edge_with_output(graph.edges, "libcore.a")
				local rules = with_rule(graph, lib_edge.rule, {
					command = 'cmd.exe /C "$PRE_LINK && C:/tools/ar.exe qc $TARGET_FILE $LINK_FLAGS $in && $POST_BUILD"',
				})
				local nested = with_vars(lib_edge, {
					PRE_LINK = ":",
					POST_BUILD = 'cmd.exe /C "cd /D ../out && C:/tools/cmake.exe -E copy a.dll b.dll"',
				})
				local resolved = ninja.resolve_edge_command(nested, rules, graph.top_vars, root(), "build")
				assert(not contains(resolved.command, '"'))
				assert(
					resolved.command
						== ": && ar.exe qc libcore.a  CMakeFiles/core.dir/src/core.c.o && cd ../out && cmake.exe -E copy a.dll b.dll",
					resolved.command
				)
				assert(same_list(sorted(resolved.tool_names), { "ar.exe", "cmake.exe" }))
			end
		),

		-- BoringSSL's CXX_STATIC_LIBRARY_LINKER rule declares `rspfile =
		-- $RSP_FILE` and `rspfile_content = $in $LINK_PATH $LINK_LIBRARIES`.
		core.test.case("resolve_edge_command resolves a rule's rspfile path and content", function()
			local graph = parse()
			local lib_edge = edge_with_output(graph.edges, "libcore.a")
			local rules = with_rule(graph, lib_edge.rule, {
				command = "/usr/bin/ar qc $TARGET_FILE $LINK_FLAGS @$RSP_FILE",
				rspfile = "$RSP_FILE",
				rspfile_content = "$in $LINK_PATH $LINK_LIBRARIES",
			})
			local rsp_edge =
				with_vars(lib_edge, { RSP_FILE = "CMakeFiles/core.rsp", LINK_PATH = "", LINK_LIBRARIES = "" })
			local resolved = ninja.resolve_edge_command(rsp_edge, rules, graph.top_vars, root(), "build")
			assert(resolved.command == "ar qc libcore.a  @CMakeFiles/core.rsp", resolved.command)
			assert(resolved.rspfile.path == "CMakeFiles/core.rsp")
			assert(resolved.rspfile.content == "CMakeFiles/core.dir/src/core.c.o  ", resolved.rspfile.content)
		end),

		core.test.case("resolve_edge_command returns no rspfile for a rule with no rspfile", function()
			local graph = parse()
			local lib_edge = edge_with_output(graph.edges, "libcore.a")
			assert(ninja.resolve_edge_command(lib_edge, graph.rules, graph.top_vars, root(), "build").rspfile == nil)
		end),

		core.test.case("resolve_edge_command returns nil for a rule with no command", function()
			local graph = parse()
			local all = edge_with_output(graph.edges, "all")
			assert(ninja.resolve_edge_command(all, graph.rules, graph.top_vars, root(), "build") == nil)
		end),
	}),

	core.test.suite("ninja_graph copy destinations", {
		core.test.case("finds cmake -E copy and copy_if_different destinations relative to the workspace", function()
			local destinations = ninja.extract_copy_destinations(
				"cc -o lib.so && cmake -E copy lib.so ../out/lib.so && cmake -E copy_if_different lib.so 'x/y.so'",
				"build/proj"
			)
			assert(same_list(destinations, { "build/out/lib.so", "build/proj/x/y.so" }))
		end),

		core.test.case("ignores other cmake -E commands", function()
			assert(#ninja.extract_copy_destinations("cmake -E copy_directory a b && cmake -E rm -f x", "build") == 0)
		end),

		core.test.case("join_and_normalize resolves . and .. parts", function()
			assert(ninja.join_and_normalize("build/a", "./b/../c") == "build/a/c")
			assert(ninja.join_and_normalize("build", "../../x") == "x")
		end),
	}),

	core.test.suite("ninja_graph target classification", {
		core.test.case("captures each target's real CMake type from its own comment", function()
			local graph = parse()
			assert(graph.target_types.core == "STATIC_LIBRARY")
			assert(graph.target_types.app == "EXECUTABLE")
		end),

		core.test.case("list_named_cmake_targets finds real targets by name and type, skipping bookkeeping", function()
			local named = ninja.list_named_cmake_targets(parse())
			assert(#named == 2)
			-- Sorted by name.
			assert(named[1].name == "app" and named[1].type == "EXECUTABLE")
			assert(same_list(named[1].outputs, { "app" }))
			assert(named[2].name == "core" and named[2].type == "STATIC_LIBRARY")
			assert(same_list(named[2].outputs, { "libcore.a" }))
		end),
	}),
}
