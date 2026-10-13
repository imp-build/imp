-- Graph-native CMake project discovery: one `core.expand` for each
-- `cmake_project()` call, keyed by CMake target name. The configure task
-- runs one time for each resolved input set, however many targets the
-- selected goals use.
--
-- The `create` callback reads the configured Ninja graph, finds the named
-- targets, and declares one replay task for each target (see
-- ./graph_replay), dependencies first. An executable that `add_test()`
-- names also gets a ctest task.
--
-- `cmake_library_dep()` adapts a discovered target as a `deps` entry of
-- `cc_library` or `cc_binary`. The include directories, link options, and
-- library type of a CMake target are known only after configure, but
-- `cc_task` needs them at declaration time. The caller thus gives them.
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local test_workflow = require("@imp/rules/workflows/test")
local core = require("@imp/core")
local replay = require("./graph_replay")
local ninja = require("./ninja_graph")

local BUILD = build.BUILD
local PACKAGE = package.PACKAGE
local TEST = test_workflow.TEST

-- Each spec that `cmake_project()` declares, in declaration order. The C
-- BUILD generator reads it to find duplicates.
local cmake_specs = {}

--- The specs of the declared CMake projects, in declaration order.
local function cmake_project_specs()
	return table.clone(cmake_specs)
end

local function target_names_of(target)
	return if #target.outputs > 0 then target.outputs else { target.name }
end

local function set_of(values)
	local set = {}
	for _, value in ipairs(values) do
		set[value] = true
	end
	return set
end

--- The first pass of discovery: the other named targets that each target
--- references, as `{ [name] = { { name, output_paths }, ... } }`.
---
--- The walk of a target stops at the final outputs of the other targets
--- (see `reachable_edges_bounded` in ./ninja_graph). `output_paths` holds
--- each output of the dependency that this target references through `|` or
--- `||`. Both kinds matter: on Windows, a SHARED_LIBRARY dependency has a
--- `.dll.a` import library that the link needs (`|`), and a `.dll` that the
--- built executable needs at run time (`||`).
local function cross_target_dependencies(named, ninja_graph)
	local cross_deps = {}
	for _, target in ipairs(named) do
		local own = set_of(target_names_of(target))
		local boundary = {}
		for _, other in ipairs(named) do
			if other.name == target.name then
				continue
			end
			for _, path in ipairs(other.outputs) do
				if not own[path] then
					boundary[path] = true
				end
			end
		end
		local reached = ninja.reachable_edges_bounded(ninja_graph.edges, target_names_of(target), boundary)
		local hit = set_of(reached.boundaries)
		local deps = {}
		for _, other in ipairs(named) do
			if other.name == target.name then
				continue
			end
			local output_paths = {}
			for _, path in ipairs(other.outputs) do
				if hit[path] then
					table.insert(output_paths, path)
				end
			end
			if #output_paths > 0 then
				table.insert(deps, { name = other.name, output_paths = output_paths })
			end
		end
		cross_deps[target.name] = deps
	end
	return cross_deps
end

--- The targets in the order of the second pass: dependencies before
--- dependents, so that each replay task can take the task handles of its
--- dependencies. A CMake target graph has no cycles, so a cycle here means
--- that the boundary detection is wrong, and the call fails.
local function topo_sort_targets(named, cross_deps)
	local remaining = {}
	for _, target in ipairs(named) do
		remaining[target.name] = {}
		for _, dep in ipairs(cross_deps[target.name]) do
			remaining[target.name][dep.name] = true
		end
	end
	local ordered = {}
	local placed = {}
	local progressed = true
	while #ordered < #named and progressed do
		progressed = false
		for _, target in ipairs(named) do
			if placed[target.name] or next(remaining[target.name]) ~= nil then
				continue
			end
			table.insert(ordered, target)
			placed[target.name] = true
			for _, deps in pairs(remaining) do
				deps[target.name] = nil
			end
			progressed = true
		end
	end
	if #ordered < #named then
		local cyclic = {}
		for _, target in ipairs(named) do
			if not placed[target.name] then
				table.insert(cyclic, target.name)
			end
		end
		error(
			`cmake project: cyclic target dependency detected among {table.concat(cyclic, ", ")} - not expected from any valid CMakeLists.txt`,
			0
		)
	end
	return ordered
end

--- The `target_deps` argument of the replay of `target_name`:
--- `{ [dep name] = { outputs, task, file_indices } }`.
---
--- `file_indices` has the 1-based index of each output of the dependency
--- that this target references, not only the first output. On Windows the
--- link needs the `.dll.a` import library, and the executable needs the
--- `.dll` at run time. Replay builds each target in its own directory, so
--- each referenced output must be mounted.
local function build_target_deps(target_name, named, cross_deps, built_by_name)
	local by_name = {}
	for _, target in ipairs(named) do
		by_name[target.name] = target
	end
	local result = {}
	for _, dep in ipairs(cross_deps[target_name]) do
		local dep_target = by_name[dep.name]
		local file_indices = {}
		for _, output_path in ipairs(dep.output_paths) do
			local file_index = table.find(dep_target.outputs, output_path)
			if file_index == nil then
				error(
					`cmake project: '{target_name}' depends on '{dep.name}' via output '{output_path}', but that output isn't among '{dep.name}''s own declared outputs ({table.concat(dep_target.outputs, ", ")}) - cross_target_dependencies() and this function have gone out of sync`,
					0
				)
			end
			table.insert(file_indices, file_index)
		end
		result[dep.name] = {
			outputs = dep_target.outputs,
			task = built_by_name[dep.name],
			file_indices = file_indices,
		}
	end
	return result
end

--- The expansion of each real CMake target (`add_library` and
--- `add_executable`) of a project. See `cmake_project` for the options and
--- the result.
local function cmake_project_expansion(options)
	local spec = replay.cmake_project_spec(options)
	table.insert(cmake_specs, spec)
	local configured = replay.configure_cmake_project(spec)
	local scanned = replay.scan_cmake_compiler_inputs(spec, configured)

	return core.expand({
		display = `expand cmake project {spec.path}`,
		inputs = {
			ninja_graph = configured.outputs.ninja_graph,
			source_paths = configured.outputs.source_paths,
			compiler_manifest = scanned.outputs.manifest,
		},
		create = function(inputs)
			local ninja_graph = inputs.ninja_graph
			local tests_by_basename = replay.correlate_ctest_entries(ninja_graph)
			local named = ninja.list_named_cmake_targets(ninja_graph)
			local cross_deps = cross_target_dependencies(named, ninja_graph)

			local built_by_name = {}
			for _, target in ipairs(topo_sort_targets(named, cross_deps)) do
				built_by_name[target.name] = replay.replay_cmake_target(
					spec,
					configured,
					ninja_graph,
					target_names_of(target),
					target.outputs,
					build_target_deps(target.name, named, cross_deps, built_by_name),
					inputs.source_paths,
					inputs.compiler_manifest
				)
			end

			local children = {}
			for _, target in ipairs(named) do
				local test_names = {}
				local seen = {}
				if target.type == "EXECUTABLE" then
					local candidates = { target.name }
					table.move(target.outputs, 1, #target.outputs, 2, candidates)
					for _, candidate in ipairs(candidates) do
						for _, name in ipairs(tests_by_basename[replay.basename(candidate)] or {}) do
							if not seen[name] then
								seen[name] = true
								table.insert(test_names, name)
							end
						end
					end
				end
				-- A target can list more than one output, but only the first
				-- is its BUILD and PACKAGE product: one target, one product.
				local artifact = built_by_name[target.name].outputs.file1
				local child = { [BUILD] = artifact, [PACKAGE] = artifact }
				if #test_names > 0 then
					child[TEST] = {
						unit = replay.run_ctest_task(
							spec,
							configured,
							ninja_graph,
							target_names_of(target),
							test_names,
							build_target_deps(target.name, named, cross_deps, built_by_name),
							inputs.source_paths,
							inputs.compiler_manifest
						).outputs.units,
					}
				end
				children[target.name] = child
			end
			return children
		end,
	})
end

--- Declare a CMake project. Options:
---
---   path                 Workspace-relative CMakeLists.txt directory. The
---                        default is the directory of the calling BUILD
---                        module.
---   build_dir            Build directory. The default is `build/<path>`.
---   srcs                 Source globs that configure and replay read. The
---                        default has the C and C++ sources and headers.
---   dirs                 Extra directories to mount, for example vendored
---                        includes.
---   extra_globs          Extra project-relative files for compiler edges,
---                        for inputs without a standard header suffix.
---   deps                 Artifact handles for configure and replay. The
---                        CMake arguments state how the project uses them.
---   cmake_args           Extra `cmake -S -B` arguments.
---   toolchain            A gcc or MSVC provider, or a union. The default
---                        is the gcc default. zig is not supported.
---   cmake_toolchain      A `graph_toolchain()` of
---                        @imp/rules/c/cmake/toolchain. The default is the
---                        declared CMake default.
---   unsafe_system_paths  Skip the Bootlin wrapper guard that rejects
---                        `-I`, `-isystem`, and `-L` flags under /usr/include
---                        or /usr/lib, so that the project can use host
---                        system packages.
---
--- Returns an expansion: `project:get(cmake_target_name, workflow, facet?)`
--- and `project:all(workflow, facet?)`. `workflow` is BUILD, PACKAGE, or
--- TEST. The TEST facet is always "unit".
local function cmake_project(options)
	return cmake_project_expansion(options or {})
end

--- Adapt a discovered CMake target as a `deps` entry of `cc_library` or
--- `cc_binary`. Options:
---
---   include_dirs  Include directories that consumers need, for example the
---                 public header directory of the project.
---   linkopts      Link options that consumers need to resolve the shared
---                 library dependencies of this target, for example
---                 pkg-config `-L` and `-l` flags.
---   shared        True for an `add_library(... SHARED ...)` target. The
---                 artifact then goes in `transitive_shared_libs`, not in
---                 `transitive_archives`, as for `cc_library({ shared =
---                 true })`.
local function cmake_library_dep(project, name, options)
	options = options or {}
	local archive = project:get(name, BUILD)
	local shared = options.shared == true
	return table.freeze({
		[BUILD] = archive,
		archive = archive,
		-- One list or the other, never both: `ar` must never receive a
		-- shared library.
		transitive_archives = if shared then {} else { archive },
		transitive_shared_libs = if shared then { archive } else {},
		transitive_import_libs = {},
		transitive_include_dirs = table.clone(options.include_dirs or {}),
		transitive_hdrs = {},
		transitive_linkopts = table.clone(options.linkopts or {}),
	})
end

return {
	build_target_deps = build_target_deps,
	cmake_library_dep = cmake_library_dep,
	cmake_project = cmake_project,
	cmake_project_expansion = cmake_project_expansion,
	cmake_project_specs = cmake_project_specs,
	cross_target_dependencies = cross_target_dependencies,
	topo_sort_targets = topo_sort_targets,
}
