-- The task layer of the CMake rules. It configures a project, scans the
-- compiler inputs, replays the Ninja edges of one target, and runs CTest.
-- The text parsers are in ./ninja_graph and ./ctest_testfile.
--
--   - `configure_cmake_project(spec)` runs `cmake -S -B -G Ninja` one time
--     and parses the generated Ninja graph. One task for each project.
--   - `scan_cmake_compiler_inputs(spec, configured)` finds the workspace
--     headers of each compiler edge.
--   - `replay_cmake_target(...)` replays each Ninja edge that the target
--     needs as its own action, in dependency waves. One task for each call,
--     so that ./expansion declares one replay task for each CMake target. A
--     C or C++ compiler action receives only its direct source, its scanned
--     headers, and declared extra inputs. Other edges receive the full
--     project input, because Ninja does not state all files that they read.
--   - `run_ctest_task(...)` replays a target and runs ctest.
--
-- The planning steps are pure functions (`configured_graph`,
-- `scan_manifest`, `plan_replay`), so that tests can examine them without a
-- real CMake run.
--
-- CMake writes CMAKE_C_COMPILER and the other tool paths into build.ninja.
-- Later replay actions read build.ninja in other sandboxes, so the paths
-- must be absolute host paths that stay the same. gcc and MSVC give such
-- paths. The zig provider has no CMake support.
--
-- Differences from the JavaScript module:
--   - The Luau host runs one action at a time, so the edges of a wave run
--     one after another.
--   - Replay actions get the tools of the task inputs (the compiler
--     provider, cmake, mkdir, cp, and dirname). The providers have no
--     `toolSpec(name)`.
--   - Nested CTestTestfile.cmake files are found through the `subdirs()`
--     entries of the top-level file, not through a list of the digest.
local core = require("@imp/core")
local test_workflow = require("@imp/rules/workflows/test")
local c_toolchain = require("@imp/rules/c/toolchain")
local gcc = require("@imp/rules/c/gcc")
local msvc = require("@imp/rules/c/msvc")
local zig = require("@imp/rules/c/zig")
local cmake_tools = require("./toolchain")
local ninja = require("./ninja_graph")
local ctest_testfile = require("./ctest_testfile")
local output = core.output

local DEFAULT_SRCS = table.freeze({
	"CMakeLists.txt",
	"**/*.c",
	"**/*.cc",
	"**/*.cpp",
	"**/*.cxx",
	"**/*.h",
	"**/*.hh",
	"**/*.hpp",
	"**/*.hxx",
	"**/*.inc",
	"**/*.inl",
	"**/*.ipp",
	"**/*.tpp",
})

local INCLUDE_LIKE_SUFFIXES = table.freeze({ ".h", ".hh", ".hpp", ".hxx", ".inc", ".inl", ".ipp", ".tpp" })

local BASE_TOOL_NAMES = table.freeze({ mkdir = true, cp = true, dirname = true })

local function append(list, values)
	for _, value in ipairs(values) do
		table.insert(list, value)
	end
	return list
end

local function sorted_unique(values)
	local seen = {}
	local result = {}
	for _, value in ipairs(values) do
		if not seen[value] then
			seen[value] = true
			table.insert(result, value)
		end
	end
	table.sort(result)
	return result
end

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

local function set_of(values)
	local set = {}
	for _, value in ipairs(values) do
		set[value] = true
	end
	return set
end

local function resolve_cmake_toolchain(toolchain)
	local resolved = toolchain or cmake_tools.default_graph_toolchain()
	if resolved == nil then
		error(
			"cmake_project() needs a declared CMake default (see @imp/rules/c/cmake/toolchain) or an explicit cmake_toolchain option",
			0
		)
	end
	return resolved
end

-- `toolchain` can be a provider or a `cc_toolchain_for_platform` union.
-- zig fails here, at declaration time.
local function require_cc_toolchain(toolchain)
	local selected = c_toolchain.select_cc_toolchain(toolchain) or gcc.default_graph_toolchain()
	if selected == nil then
		error(
			"cmake_project() needs an explicit gcc or msvc toolchain, or a declared gcc default - see @imp/rules/c/gcc and @imp/rules/c/msvc",
			0
		)
	end
	if zig.is_zig_toolchain(selected) then
		error(
			"cmake_project() doesn't support a zig toolchain yet - the zig tool has no absolute named-cache path for CMake to write into build.ninja; pass a gcc.graph_toolchain() or msvc.msvc_toolchain() instead",
			0
		)
	end
	return selected
end

--- Normalize the options of `cmake_project()` into the spec that the tasks
--- of this module take. See `cmake_project` in ./expansion for the options.
local function cmake_project_spec(options)
	options = options or {}
	local path = options.path or core.package_path()
	local build_dir_path = options.build_dir or `build/{if path == "." then "cmake" else path}`
	local extra_globs = options.extra_globs or {}
	local dir_keys = {}
	local dir_inputs = {}
	for i, dir in ipairs(options.dirs or {}) do
		local key = `dir{i}`
		table.insert(dir_keys, key)
		dir_inputs[key] = core.files({ root = `{path}/{dir}`, include = { "**/*" } })
	end
	return table.freeze({
		path = path,
		build_dir_path = build_dir_path,
		cmake_args = table.clone(options.cmake_args or {}),
		srcs_input = core.files({ root = path, include = options.srcs or DEFAULT_SRCS }),
		extra_input = if #extra_globs > 0 then core.files({ root = path, include = extra_globs }) else nil,
		dir_keys = dir_keys,
		dir_inputs = dir_inputs,
		deps = table.clone(options.deps or {}),
		toolchain = require_cc_toolchain(options.toolchain),
		cmake_toolchain = resolve_cmake_toolchain(options.cmake_toolchain),
		-- Skip the unsafe-path guard of the Bootlin compiler wrapper, so that
		-- the project can use host system packages such as
		-- libwebkit2gtk-4.1. See @imp/rules/c/gcc.
		unsafe_system_paths = options.unsafe_system_paths == true,
	})
end

local function dir_input_values(spec, input)
	local values = {}
	for _, key in ipairs(spec.dir_keys) do
		table.insert(values, input[key])
	end
	return values
end

local function add_spec_inputs(inputs, spec, dep_prefix)
	for key, handle in pairs(spec.dir_inputs) do
		inputs[key] = handle
	end
	for i, dep in ipairs(spec.deps) do
		inputs[`{dep_prefix}{i}`] = dep
	end
	for key, handle in pairs(spec.toolchain.task_inputs()) do
		inputs[key] = handle
	end
	return inputs
end

local function dep_input_values(spec, input, dep_prefix)
	local values = {}
	for i in ipairs(spec.deps) do
		table.insert(values, input[`{dep_prefix}{i}`])
	end
	return values
end

local function join_dir(dir, name)
	return if dir == "" then name else `{dir}/{name}`
end

--- Parse the files that a configure wrote. `read_generated(path)` returns
--- the text of a file relative to the build directory, or fails when the
--- file does not exist.
---
--- Returns `graph, ctest_paths`. `graph` is `{ rules, edges, top_vars,
--- target_types, sandbox_root, ctest_text }`. `ctest_paths` lists each
--- CTestTestfile.cmake relative to the workspace: the top-level file and
--- each file that a `subdirs()` entry reaches.
---
--- CTestTestfile.cmake writes the executable of each test as an absolute
--- path in the configure sandbox. `ctest_text` has that sandbox build
--- directory (`cmake_ninja_workdir`) removed, so the paths become relative
--- tokens that ctest resolves from `--test-dir`. A rewrite at run time would
--- put the path of the current sandbox into a cached action, and a cache hit
--- would then replay a path that is not valid.
local function configured_graph(read_generated, build_dir_path)
	local graph = ninja.parse_ninja(read_generated("build.ninja"), read_generated)
	local workdir = graph.top_vars.cmake_ninja_workdir
	graph.sandbox_root = ninja.sandbox_root_from_workdir(workdir, build_dir_path)

	local ctest_paths = {}
	local top_text = nil
	local visited = {}
	local workdir_root = if workdir then string.gsub(workdir, "/+$", "") else nil
	local function visit(dir)
		local rel = join_dir(dir, "CTestTestfile.cmake")
		if visited[rel] then
			return
		end
		visited[rel] = true
		local ok, text = pcall(read_generated, rel)
		if not ok or text == nil then
			return
		end
		table.insert(ctest_paths, `{build_dir_path}/{rel}`)
		if dir == "" then
			top_text = text
		end
		for _, sub in ipairs(ctest_testfile.parse_subdirs(text)) do
			local normalized = string.gsub(sub, "\\", "/")
			if workdir_root ~= nil and string.sub(normalized, 1, #workdir_root + 1) == workdir_root .. "/" then
				-- An absolute path in the configure build directory.
				visit(string.sub(normalized, #workdir_root + 2))
			elseif not string.find(normalized, "^/") and not string.find(normalized, "^%a:/") then
				visit(ninja.join_and_normalize(dir, normalized))
			end
		end
	end
	visit("")

	if top_text ~= nil and workdir ~= nil then
		top_text = ninja.replace_all(top_text, workdir, "")
	end
	graph.ctest_text = top_text
	return graph, ctest_paths
end

--- Declare the configure task of a project. Its outputs are `directory`
--- (the configured build directory, an artifact), `ninja_graph` (the value
--- of `configured_graph`), and `source_paths` (the workspace paths that
--- `srcs` captured).
local function configure_cmake_project(spec)
	local inputs = add_spec_inputs({
		srcs = spec.srcs_input,
		ninja = core.native_tool("ninja"),
		cmake_tool = spec.cmake_toolchain.tool,
		sed = core.native_tool("sed"),
	}, spec, "dep")
	return core.task({
		inputs = inputs,
		outputs = {
			directory = output.artifact(),
			ninja_graph = output.value(),
			source_paths = output.value(),
		},
		run = function(exec, input)
			local configure = spec.toolchain.cmake_configure(exec, input, {
				unsafe_system_paths = spec.unsafe_system_paths,
			})
			-- Run cmake directly, not through `sh`. cmake and the processes
			-- that it starts (try_compile runs cmake, ninja, and the compiler)
			-- are then native children of Imp, and get the TMP and TEMP of the
			-- sandbox. The MSYS `sh` of Git for Windows drops them for native
			-- children.
			local argv = {
				cmake_tools.cmake_bin(exec, input.cmake_tool),
				"-S",
				spec.path,
				"-B",
				spec.build_dir_path,
				"-G",
				"Ninja",
			}
			append(argv, configure.compiler_args)
			append(argv, spec.cmake_args)
			local action_inputs = { input.srcs }
			append(action_inputs, dir_input_values(spec, input))
			append(action_inputs, dep_input_values(spec, input, "dep"))
			local configured = exec.action({
				argv = argv,
				inputs = action_inputs,
				env = configure.env,
				outputs = { directory = output.directory(spec.build_dir_path) },
				display = `cmake configure {spec.path}`,
			})

			-- A directory output nests under its declared path.
			local digest = exec.digest(configured.outputs.directory)
			local function read_generated(rel_path)
				return core.read_file_in_digest(digest, `{spec.build_dir_path}/{rel_path}`)
			end
			local graph, ctest_paths = configured_graph(read_generated, spec.build_dir_path)

			local directory = configured.outputs.directory
			local workdir = graph.top_vars.cmake_ninja_workdir
			if #ctest_paths > 0 and workdir ~= nil then
				-- Patch the files that ctest reads, with the same rewrite as
				-- `ctest_text`. `sh` runs sed: the sed of Git for Windows is an
				-- MSYS program, which does not start as a native child. This
				-- step starts no compiler, so the TMP problem above does not
				-- apply.
				local patch_argv = {
					"sh",
					"-c",
					'pattern=$1; shift; sed -i "$pattern" "$@"',
					"cmake-patch-ctest",
					`s#{workdir}##g`,
				}
				append(patch_argv, ctest_paths)
				local patched = exec.action({
					argv = patch_argv,
					inputs = { configured.outputs.directory },
					outputs = { directory = output.directory(spec.build_dir_path) },
					display = `cmake patch ctest paths {spec.path}`,
				})
				directory = patched.outputs.directory
			end

			return {
				directory = directory,
				source_paths = exec.paths(input.srcs),
				ninja_graph = graph,
			}
		end,
	})
end

local function basename(path)
	local name = string.match(path, "([^/]*)$")
	return name
end

--- The CTest test names of `ninja_graph`, by the basename of the test
--- executable: `{ [basename] = { name, ... } }`.
local function correlate_ctest_entries(ninja_graph)
	local tests_by_basename = {}
	if ninja_graph.ctest_text == nil then
		return tests_by_basename
	end
	for _, entry in ipairs(ctest_testfile.parse_ctest_testfile(ninja_graph.ctest_text)) do
		local command_path = entry.command[1]
		if command_path == nil or command_path == "" then
			continue
		end
		local key = basename(ninja.rebase_path(command_path, ninja_graph.sandbox_root))
		tests_by_basename[key] = tests_by_basename[key] or {}
		table.insert(tests_by_basename[key], entry.name)
	end
	return tests_by_basename
end

--- True for a C or C++ compiler edge. CMake writes `deps = gcc` for
--- GCC-like compilers and `deps = msvc` for cl.exe.
local function is_cmake_compiler_edge(edge, rules)
	local rule = rules[edge.rule]
	return rule ~= nil and (rule.deps == "gcc" or rule.deps == "msvc")
end

--- The workspace sources that a compiler edge reads directly, sorted. Only
--- paths that the configure `srcs` captured count, so generated files and
--- edge outputs are never workspace sources.
local function compiler_workspace_sources(edge, rules, sandbox_root, source_paths)
	if not is_cmake_compiler_edge(edge, rules) then
		return {}
	end
	local captured = set_of(source_paths)
	local found = {}
	for _, path in ipairs(edge.inputs) do
		local rebased = ninja.rebase_path(path, sandbox_root)
		if captured[rebased] then
			table.insert(found, rebased)
		end
	end
	for _, path in ipairs(edge.implicit_inputs) do
		local rebased = ninja.rebase_path(path, sandbox_root)
		if captured[rebased] then
			table.insert(found, rebased)
		end
	end
	return sorted_unique(found)
end

local function include_like_sources(source_paths)
	local found = {}
	for _, path in ipairs(source_paths) do
		local lower = string.lower(path)
		for _, suffix in ipairs(INCLUDE_LIKE_SUFFIXES) do
			if string.sub(lower, -#suffix) == suffix then
				table.insert(found, path)
				break
			end
		end
	end
	table.sort(found)
	return found
end

local function compiler_edge_key(edge)
	return edge.outputs[1] or edge.implicit_outputs[1] or edge.rule
end

local function up_from_build_dir(build_dir_path)
	local parts = {}
	for _, part in ipairs(string.split(build_dir_path, "/")) do
		if part ~= "" then
			table.insert(parts, "..")
		end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end

--- Parse the output of `ninja -t deps`: an output line ends in
--- `: #deps ...`, and the indented lines after it are its dependencies.
--- Returns `{ [output] = { path, ... } }`.
local function parse_ninja_deps(text)
	local deps = {}
	local current = nil
	for _, line in ipairs(string.split(text, "\n")) do
		local record = string.match(line, "^(.*): #deps %d+")
		if record ~= nil then
			current = record
			deps[current] = {}
		elseif current ~= nil and string.find(line, "^%s+%S") then
			local path = string.match(line, "^%s*(.-)%s*$")
			table.insert(deps[current], (string.gsub(path, "\\", "/")))
		elseif line == "" then
			current = nil
		end
	end
	return deps
end

local function scan_path_to_workspace_path(path, build_dir_path, source_set)
	local normalized = string.gsub(path, "\\", "/")
	if source_set[normalized] then
		return normalized
	end
	if string.find(normalized, "^/") or string.find(normalized, "^%a:/") then
		return nil
	end
	local workspace_path = ninja.join_and_normalize(build_dir_path, normalized)
	return if source_set[workspace_path] then workspace_path else nil
end

--- The header plan of each compiler edge, from the output of
--- `ninja -t deps`: `{ [edge key] = { headers } }`, or
--- `{ fallback = reason, headers = {} }` when the record is not complete.
local function scan_manifest(ninja_graph, source_paths, build_dir_path, deps_text)
	local source_set = set_of(source_paths)
	local deps = parse_ninja_deps(deps_text or "")
	local manifest = {}
	for _, edge in ipairs(ninja_graph.edges) do
		if not is_cmake_compiler_edge(edge, ninja_graph.rules) then
			continue
		end
		local key = compiler_edge_key(edge)
		local recorded = deps[key]
		if recorded == nil then
			manifest[key] = { fallback = "Ninja did not report compiler dependencies", headers = {} }
			continue
		end
		local direct = compiler_workspace_sources(edge, ninja_graph.rules, ninja_graph.sandbox_root, source_paths)
		local recorded_set = {}
		for _, path in ipairs(recorded) do
			local workspace_path = scan_path_to_workspace_path(path, build_dir_path, source_set)
			if workspace_path ~= nil then
				recorded_set[workspace_path] = true
			end
		end
		local complete = true
		for _, path in ipairs(direct) do
			if not recorded_set[path] then
				complete = false
				break
			end
		end
		if not complete then
			manifest[key] = { fallback = "Ninja dependency record omitted the direct source", headers = {} }
			continue
		end
		local direct_set = set_of(direct)
		local headers = {}
		for path in pairs(recorded_set) do
			if not direct_set[path] then
				table.insert(headers, path)
			end
		end
		table.sort(headers)
		manifest[key] = { headers = headers }
	end
	return manifest
end

local function is_cmake_module_edge(edge, rules)
	local dyndep = edge.vars.dyndep
	return is_cmake_compiler_edge(edge, rules) and dyndep ~= nil and dyndep ~= ""
end

-- The scan script. It patches only the compiler rules in the private copy
-- of the configured tree of this action, so that each compile only checks
-- syntax and writes no object. Ninja keeps its depfile or /showIncludes
-- parser, and one Ninja run schedules all compiler scans. The build output
-- goes to stderr.
local SCAN_SCRIPT = table.concat({
	'bdir=$1 oldroot=$2 up=$3 mode=$4; ',
	'cd "$bdir" || exit 0; ',
	'[ -z "$oldroot" ] || sed -i "s|$oldroot|$up|g" build.ninja CMakeFiles/rules.ninja 2>/dev/null; ',
	'if [ "$mode" = msvc ]; then flag=/Zs; else flag=-fsyntax-only; fi; ',
	'sed -E -i "/^rule (C|CXX)_COMPILER/,/^$/ { /^  command = / s/$/ $flag/ }" CMakeFiles/rules.ninja; ',
	'set -- $(ninja -f build.ninja -t targets all | sed -n -E "s/: (C|CXX)_COMPILER.*$//p"); ',
	'[ "$#" -eq 0 ] || ninja -f build.ninja -k 0 "$@" >&2; ',
	"ninja -f build.ninja -t deps > .imp-cmake-deps.txt 2>/dev/null; exit 0",
})

--- Declare the task that runs the compiler rules of CMake in syntax-only
--- mode one time, and returns the workspace headers that Ninja recorded
--- for each compiler edge (`outputs.manifest`, see `scan_manifest`). The task
--- comes before the expansion, so its value can shape the replay tasks.
local function scan_cmake_compiler_inputs(spec, configured)
	local inputs = add_spec_inputs({
		configure_directory = configured.outputs.directory,
		ninja_graph = configured.outputs.ninja_graph,
		source_paths = configured.outputs.source_paths,
		srcs = spec.srcs_input,
		extra = spec.extra_input,
		ninja = core.native_tool("ninja"),
		sed = core.native_tool("sed"),
	}, spec, "dep")
	return core.task({
		inputs = inputs,
		outputs = { manifest = output.value() },
		run = function(exec, input)
			local has_compiler_edge = false
			for _, edge in ipairs(input.ninja_graph.edges) do
				if is_cmake_compiler_edge(edge, input.ninja_graph.rules) then
					has_compiler_edge = true
					break
				end
			end
			if not has_compiler_edge then
				return { manifest = {} }
			end

			local state = spec.toolchain.resolve_state(exec, input)
			local action_inputs = { input.configure_directory, input.srcs }
			if spec.extra_input ~= nil then
				table.insert(action_inputs, input.extra)
			end
			append(action_inputs, dir_input_values(spec, input))
			append(action_inputs, dep_input_values(spec, input, "dep"))
			local deps_path = `{spec.build_dir_path}/.imp-cmake-deps.txt`
			-- A failing scanner does not stop the scan. When the action fails
			-- before it writes its output, each edge gets a broad fallback.
			local ok, scan = pcall(exec.action, {
				argv = {
					"sh",
					"-c",
					SCAN_SCRIPT,
					"cmake-dependency-scan",
					spec.build_dir_path,
					input.ninja_graph.sandbox_root or "",
					up_from_build_dir(spec.build_dir_path),
					if msvc.is_msvc_toolchain(spec.toolchain) then "msvc" else "gcc",
				},
				inputs = action_inputs,
				env = spec.toolchain.edge_env(state),
				outputs = { scan = output.file(deps_path) },
				display = `cmake scan {spec.path}`,
				allow_failure = true,
			})
			local deps_text = ""
			if ok then
				local read_ok, text = pcall(core.read_file_in_digest, exec.digest(scan.outputs.scan), deps_path)
				if read_ok then
					deps_text = text
				end
			end
			return {
				manifest = scan_manifest(input.ninja_graph, input.source_paths, spec.build_dir_path, deps_text),
			}
		end,
	})
end

--- Plan the replay of `target_names`: the edges in dependency waves and the
--- inputs of each compiler edge. It does not declare tasks.
---
--- `target_deps` is `{ [target name] = { outputs, task, file_indices } }`
--- (see `build_target_deps` in ./expansion). Their outputs stop the walk,
--- so this replay takes the artifacts of the other target as inputs and
--- does not derive its edges again.
---
--- Returns `{ waves, compiler_sources, compiler_headers, compiler_input_plan,
--- source_paths, header_paths }`. `waves` is a list of edge lists.
--- `compiler_sources` and `compiler_headers` map each edge to paths. The
--- other fields are sorted path lists and the plan of each compiler edge
--- key. Fails for a C++ module edge (`dyndep`).
local function plan_replay(spec, ninja_graph, target_names, target_deps, source_paths, compiler_manifest)
	local rules = ninja_graph.rules
	local sandbox_root = ninja_graph.sandbox_root
	local boundary = {}
	for _, dep in pairs(target_deps) do
		for _, path in ipairs(dep.outputs) do
			boundary[path] = true
		end
	end
	local all_reached = ninja.reachable_edges_bounded(ninja_graph.edges, target_names, boundary).edges
	local reached = {}
	for _, edge in ipairs(all_reached) do
		if ninja.is_command_edge(edge, rules) then
			table.insert(reached, edge)
		end
	end

	local all_by_output = {}
	for _, edge in ipairs(all_reached) do
		for _, path in ipairs(ninja.edge_outputs(edge)) do
			all_by_output[path] = edge
		end
	end
	-- The level of an edge is the number of command edges on its longest
	-- dependency chain. An edge runs after each edge of a lower level.
	local levels = {}
	local function level_of(edge)
		if levels[edge] ~= nil then
			return levels[edge]
		end
		local dep_level = 0
		for _, dep in ipairs(ninja.edge_dependencies(edge)) do
			local dep_edge = all_by_output[dep]
			if dep_edge ~= nil and dep_edge ~= edge then
				dep_level = math.max(dep_level, level_of(dep_edge))
			end
		end
		local level = if ninja.is_command_edge(edge, rules) then dep_level + 1 else dep_level
		levels[edge] = level
		return level
	end
	local waves_by_level = {}
	local max_level = 0
	for _, edge in ipairs(reached) do
		local level = level_of(edge)
		waves_by_level[level] = waves_by_level[level] or {}
		table.insert(waves_by_level[level], edge)
		max_level = math.max(max_level, level)
	end
	local waves = {}
	for level = 0, max_level do
		if waves_by_level[level] ~= nil then
			table.insert(waves, waves_by_level[level])
		end
	end

	local compiler_sources = {}
	local all_sources = {}
	for _, edge in ipairs(reached) do
		compiler_sources[edge] = compiler_workspace_sources(edge, rules, sandbox_root, source_paths)
		append(all_sources, compiler_sources[edge])
	end
	local compiler_source_paths = sorted_unique(all_sources)
	local compiler_source_set = set_of(compiler_source_paths)
	local fallback_header_paths = {}
	for _, path in ipairs(include_like_sources(source_paths)) do
		if not compiler_source_set[path] then
			table.insert(fallback_header_paths, path)
		end
	end

	local compiler_headers = {}
	local compiler_input_plan = {}
	local all_headers = {}
	for _, edge in ipairs(reached) do
		if not is_cmake_compiler_edge(edge, rules) then
			continue
		end
		local key = compiler_edge_key(edge)
		if is_cmake_module_edge(edge, rules) then
			error(
				`cmake project '{spec.path}' target '{table.concat(target_names, ",")}' uses C++ module/dyndep edge '{key}'; CMake dependency scanning does not support modules yet`,
				0
			)
		end
		local scanned = compiler_manifest[key]
		local fallback = if scanned == nil then "no scan manifest" else scanned.fallback
		local headers = if fallback ~= nil then fallback_header_paths else scanned.headers
		compiler_headers[edge] = headers
		compiler_input_plan[key] = { headers = headers, fallback = fallback }
		append(all_headers, headers)
	end

	return {
		waves = waves,
		compiler_sources = compiler_sources,
		compiler_headers = compiler_headers,
		compiler_input_plan = compiler_input_plan,
		source_paths = compiler_source_paths,
		header_paths = sorted_unique(all_headers),
	}
end

-- One files handle for one workspace file.
local function file_input(path)
	local dir, name = string.match(path, "^(.*)/([^/]+)$")
	if dir == nil then
		return core.files({ root = ".", include = { path } })
	end
	return core.files({ root = dir, include = { name } })
end

-- On Windows, the sh.exe of Git for Windows cuts each argv element at
-- approximately 8186 bytes and gives no error. BoringSSL's crypto target
-- needs approximately 19 KB of object list. The response file content thus
-- goes through many small argv elements.
local RSPFILE_CHUNK_SIZE = 4000

local function chunk_rspfile_content(content)
	local chunks = {}
	for start = 1, #content, RSPFILE_CHUNK_SIZE do
		table.insert(chunks, string.sub(content, start, start + RSPFILE_CHUNK_SIZE - 1))
	end
	return chunks
end

--- The argv that runs one resolved edge in the build directory. With a
--- response file, the script first writes its content from the positional
--- arguments, so the content is never read as shell syntax.
local function edge_argv(build_dir_path, resolved)
	if resolved.rspfile == nil then
		return { "sh", "-c", `cd '{build_dir_path}' && {resolved.command}` }
	end
	local script = `cd '{build_dir_path}' && `
		.. [[{ rsp=$1; shift; : > "$rsp"; for chunk; do printf '%s' "$chunk" >> "$rsp"; done; } && ]]
		.. resolved.command
	return append({ "sh", "-c", script, "cmake-rsp", resolved.rspfile.path }, chunk_rspfile_content(resolved.rspfile.content))
end

-- The task input key of one output of a dependency target.
local function dep_output_key(name, index)
	return `dep_{name}_{index}`
end

local function dep_indices(dep)
	return dep.file_indices or { 1 }
end

--- Declare the task that replays each Ninja edge that `target_names` need,
--- in dependency waves.
---
--- `ninja_graph` is the resolved value of `configured.outputs.ninja_graph`:
--- the caller (the `create` callback of ./expansion) has it already.
--- `expose_outputs` lists build-directory paths that the targets make; each
--- one is also an output `file<i>`, in list order, so that the caller can
--- give one product without the full build directory. `target_deps`,
--- `source_paths`, and `compiler_manifest` go to `plan_replay`.
---
--- The outputs are `directory` (the build directory after replay, with any
--- POST_BUILD copy destinations) and `file1`, `file2`, ...
local function replay_cmake_target(
	spec,
	configured,
	ninja_graph,
	target_names,
	expose_outputs,
	target_deps,
	source_paths,
	compiler_manifest
)
	expose_outputs = expose_outputs or {}
	target_deps = target_deps or {}
	source_paths = source_paths or {}
	compiler_manifest = compiler_manifest or {}
	local plan = plan_replay(spec, ninja_graph, target_names, target_deps, source_paths, compiler_manifest)
	local rules = ninja_graph.rules

	local inputs = add_spec_inputs({
		configure_directory = configured.outputs.directory,
		srcs = spec.srcs_input,
		extra = spec.extra_input,
		cmake_tool = spec.cmake_toolchain.tool,
		mkdir = core.native_tool("mkdir"),
		cp = core.native_tool("cp"),
		dirname = core.native_tool("dirname"),
	}, spec, "graph_dep")
	local source_keys = {}
	for i, path in ipairs(plan.source_paths) do
		source_keys[path] = `source{i}`
		inputs[`source{i}`] = file_input(path)
	end
	local header_keys = {}
	for i, path in ipairs(plan.header_paths) do
		header_keys[path] = `header{i}`
		inputs[`header{i}`] = file_input(path)
	end
	local dep_names = sorted_keys(target_deps)
	for _, name in ipairs(dep_names) do
		local dep = target_deps[name]
		for _, index in ipairs(dep_indices(dep)) do
			inputs[dep_output_key(name, index)] = dep.task.outputs[`file{index}`]
		end
	end

	local outputs = { directory = output.artifact() }
	for i in ipairs(expose_outputs) do
		outputs[`file{i}`] = output.artifact()
	end

	return core.task({
		inputs = inputs,
		outputs = outputs,
		run = function(exec, input)
			local dir_values = dir_input_values(spec, input)
			local graph_dep_values = dep_input_values(spec, input, "graph_dep")
			-- Each output of a dependency target goes to each edge. An
			-- order-only reference is not in the command text, but can still
			-- be necessary, for example a DLL that the executable loads at run
			-- time. A target normally has one or two such outputs.
			local boundary_values = {}
			for _, name in ipairs(dep_names) do
				for _, index in ipairs(dep_indices(target_deps[name])) do
					table.insert(boundary_values, input[dep_output_key(name, index)])
				end
			end
			local state = nil
			local state_resolved = false
			local function toolchain_state()
				if not state_resolved then
					state = spec.toolchain.resolve_state(exec, input)
					state_resolved = true
				end
				return state
			end

			local function execute_edge(edge, prior_outputs)
				local resolved = ninja.resolve_edge_command(
					edge,
					rules,
					ninja_graph.top_vars,
					ninja_graph.sandbox_root,
					spec.build_dir_path
				)
				if resolved == nil then
					return {}
				end
				for _, name in ipairs(resolved.tool_names) do
					if
						BASE_TOOL_NAMES[name]
						or name == "cmake"
						or name == "cmake.exe"
						or spec.toolchain.resolves_tool_name(name)
					then
						continue
					end
					error(
						`cmake edge needs unsupported host tool '{name}' - only the configured cc toolchain's own tool names and cmake itself are resolvable from a graph-native CMake replay right now`,
						0
					)
				end

				local dest_paths = {}
				for _, path in ipairs(ninja.edge_outputs(edge)) do
					table.insert(dest_paths, `{spec.build_dir_path}/{path}`)
				end
				append(dest_paths, ninja.extract_copy_destinations(resolved.command, spec.build_dir_path))

				local edge_inputs = {}
				if is_cmake_compiler_edge(edge, rules) and #source_paths > 0 then
					for _, path in ipairs(plan.compiler_sources[edge]) do
						table.insert(edge_inputs, input[source_keys[path]])
					end
					for _, path in ipairs(plan.compiler_headers[edge]) do
						table.insert(edge_inputs, input[header_keys[path]])
					end
					if spec.extra_input ~= nil then
						table.insert(edge_inputs, input.extra)
					end
				else
					table.insert(edge_inputs, input.srcs)
				end
				append(edge_inputs, dir_values)
				table.insert(edge_inputs, input.configure_directory)
				append(edge_inputs, graph_dep_values)
				append(edge_inputs, prior_outputs)
				append(edge_inputs, boundary_values)

				local action_outputs = {}
				for i, path in ipairs(dest_paths) do
					action_outputs[`out{i}`] = output.file(path)
				end
				local outputs_list = ninja.edge_outputs(edge)
				local label = outputs_list[1] or edge.rule
				local plan_entry = plan.compiler_input_plan[compiler_edge_key(edge)]
				if plan_entry ~= nil and plan_entry.fallback ~= nil then
					label ..= ` [broad input fallback: {plan_entry.fallback}]`
				end
				local result = exec.action({
					argv = edge_argv(spec.build_dir_path, resolved),
					inputs = edge_inputs,
					env = spec.toolchain.edge_env(toolchain_state()),
					outputs = action_outputs,
					display = `cmake edge {label}`,
				})
				local produced = {}
				for i in ipairs(dest_paths) do
					table.insert(produced, result.outputs[`out{i}`])
				end
				return produced
			end

			local prior_outputs = {}
			for _, wave in ipairs(plan.waves) do
				local wave_outputs = {}
				for _, edge in ipairs(wave) do
					append(wave_outputs, execute_edge(edge, prior_outputs))
				end
				append(prior_outputs, wave_outputs)
			end

			-- Each edge output is staged at its build-directory path, so this
			-- action only declares the final directory and the exposed files.
			-- The dependency outputs keep the directory complete, for example
			-- for ctest, which runs a test executable from it.
			local staged_inputs = { input.configure_directory }
			append(staged_inputs, graph_dep_values)
			append(staged_inputs, prior_outputs)
			append(staged_inputs, boundary_values)
			local staged_outputs = { directory = output.directory(spec.build_dir_path) }
			for i, path in ipairs(expose_outputs) do
				staged_outputs[`file{i}`] = output.file(`{spec.build_dir_path}/{path}`)
			end
			local staged = exec.action({
				argv = { "sh", "-c", "true" },
				inputs = staged_inputs,
				outputs = staged_outputs,
				display = `cmake stage {spec.path}`,
			})
			local result = { directory = staged.outputs.directory }
			for i in ipairs(expose_outputs) do
				result[`file{i}`] = staged.outputs[`file{i}`]
			end
			return result
		end,
	})
end

-- A -R regex that matches only the exact CTest test names.
local function ctest_name_filter_args(test_names)
	if #test_names == 0 then
		return {}
	end
	local escaped = {}
	for _, name in ipairs(test_names) do
		table.insert(escaped, (string.gsub(name, "[%.%*%+%?%^%$%{%}%(%)%|%[%]\\]", "\\%0")))
	end
	return { "-R", `^({table.concat(escaped, "|")})$` }
end

--- Declare a replay of `target_names` (see `replay_cmake_target`) and a task
--- that runs ctest in the replayed build directory, for `test_names` only
--- when given. The configure task already made the CTestTestfile.cmake paths
--- relative (see `configured_graph`). The output `units` is the unit list of
--- @imp/rules/workflows/test.
local function run_ctest_task(
	spec,
	configured,
	ninja_graph,
	target_names,
	test_names,
	target_deps,
	source_paths,
	compiler_manifest
)
	test_names = test_names or {}
	local built = replay_cmake_target(
		spec,
		configured,
		ninja_graph,
		target_names,
		{},
		target_deps,
		source_paths,
		compiler_manifest
	)
	local unit_name = if #test_names > 0 then table.concat(test_names, ",") else spec.path
	return core.task({
		inputs = { directory = built.outputs.directory, ctest = core.native_tool("ctest") },
		outputs = { units = output.value() },
		run = function(exec, input)
			local argv = {
				"sh",
				"-c",
				'bdir=$1; shift; ctest --test-dir "$bdir" "$@"',
				"cmake-ctest",
				spec.build_dir_path,
			}
			append(argv, ctest_name_filter_args(test_names))
			local result = exec.action({
				argv = argv,
				inputs = { input.directory },
				display = `ctest {spec.path}`,
				allow_failure = true,
			})
			return { units = test_workflow.test_vehicle(unit_name, result) }
		end,
	})
end

return {
	basename = basename,
	cmake_project_spec = cmake_project_spec,
	compiler_workspace_sources = compiler_workspace_sources,
	configure_cmake_project = configure_cmake_project,
	configured_graph = configured_graph,
	correlate_ctest_entries = correlate_ctest_entries,
	ctest_name_filter_args = ctest_name_filter_args,
	is_cmake_compiler_edge = is_cmake_compiler_edge,
	parse_ninja_deps = parse_ninja_deps,
	plan_replay = plan_replay,
	replay_cmake_target = replay_cmake_target,
	run_ctest_task = run_ctest_task,
	scan_cmake_compiler_inputs = scan_cmake_compiler_inputs,
	scan_manifest = scan_manifest,
}
