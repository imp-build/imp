-- The `package` goal publishes selected `PACKAGE` roots under `dist/`.
--
-- A `PACKAGE` root describes what to publish and does not publish it. It
-- resolves to an artifact. The goal writes each artifact into the workspace
-- at `dist/<package>/<target>`.
--
-- This module also has `binary_product`, the shared product shape of a
-- native binary, which the C and Odin rules use.
local core = require("@imp/core")
local output = core.output

local function basename(path)
	local name = string.match(path, "([^/]+)$")
	return name or path
end

-- A shared library is published under its own filename, not the target
-- name: `libfoo.so`, `libfoo.so.1`, `libfoo.dylib`, `foo.dll`. A consumer
-- records the filename of a shared library in its own DT_NEEDED entry, and
-- the loader looks for exactly that name. An executable has no such
-- constraint, so it keeps the target name, which is easier to find in
-- `dist/`.
local function is_shared_library(path)
	local name = string.lower(path)
	if string.match(name, "%.dylib$") ~= nil or string.match(name, "%.dll$") ~= nil then
		return true
	end
	-- Remove the version suffixes of a soname, such as `.1.2.3`.
	local stem = name
	while string.match(stem, "%.%d+$") ~= nil do
		stem = string.gsub(stem, "%.%d+$", "")
	end
	return string.match(stem, "%.so$") ~= nil
end

--- Return the binary layout without declaring build tasks.
local function binary_product_layout(options)
	local bundled = #(options.shared_libraries or {}) > 0
	local bundle_dir = `build/{options.namespace}/{options.target_slug}.d`
	return { bundled = bundled, bundle_dir = bundle_dir,
		published_executable_path = if bundled then options.executable_name else nil,
		executable_path = if bundled then `{bundle_dir}/{options.executable_name}` else nil }
end

--- Plan and finish the common product shape of a native binary.
---
--- The rule gives its stable `namespace` and `target_slug`, because they are
--- part of its build paths. This function sets the directory layout in that
--- path, the condition for a shared-library bundle, and the run descriptor
--- of a bundle.
---
--- Options: `namespace`, `target_slug`, `executable_name`, optional
--- `shared_libraries` (a list of artifact handles), and `bundle_display`
--- (the display label of the bundle action).
---
--- Returns `{ bundled, bundle_dir, executable_path, finish(artifact) }`.
--- `finish` returns `{ artifact, run, bundled, executable_path }`. Without
--- shared libraries, `artifact` and `run` are the given artifact. With shared
--- libraries, `artifact` is a directory that has the executable and its
--- libraries, and `run` is a task that resolves to `{ executable,
--- executable_path }` for the `RUN` slot.
local function binary_product(options)
	local shared_libraries = options.shared_libraries or {}
	local layout = binary_product_layout(options)
	local bundled, bundle_dir, executable_path = layout.bundled, layout.bundle_dir, layout.executable_path

	local function finish(artifact)
		if not bundled then
			return { artifact = artifact, run = artifact, bundled = bundled, executable_path = executable_path }
		end

		-- The loader finds shared libraries by basename. Two libraries with the
		-- same basename overwrite each other here and collide at run time, so
		-- this function cannot bundle them.
		local inputs = { artifact = artifact, cp = core.native_tool("cp") }
		for index, library in ipairs(shared_libraries) do
			inputs[`shared_lib_{index}`] = library
		end
		local bundle = core.task({
			inputs = inputs,
			outputs = { artifact = output.artifact() },
			run = function(exec, input)
				local sources = { exec.path(input.artifact) }
				local action_inputs = { input.artifact }
				for index in ipairs(shared_libraries) do
					local library = input[`shared_lib_{index}`]
					table.insert(sources, exec.path(library))
					table.insert(action_inputs, library)
				end
				local argv = { "cp" }
				for _, source in ipairs(sources) do
					table.insert(argv, source)
				end
				table.insert(argv, `{bundle_dir}/`)
				local result = exec.action({
					argv = argv,
					inputs = action_inputs,
					outputs = { artifact = output.directory(bundle_dir) },
					display = options.bundle_display,
				})
				return { artifact = result.outputs.artifact }
			end,
		})
		local run = core.task({
			inputs = { executable = bundle.outputs.artifact },
			outputs = { executable = output.artifact(), executable_path = output.value() },
			run = function(_, input)
				return { executable = input.executable, executable_path = executable_path }
			end,
		})
		return {
			artifact = bundle.outputs.artifact,
			run = run,
			bundled = bundled,
			executable_path = executable_path,
		}
	end

	return {
		bundled = bundled,
		bundle_dir = bundle_dir,
		executable_path = executable_path,
		finish = finish,
	}
end

--- Publish the artifacts of the selected `PACKAGE` roots under `dist/`, and
--- return the report.
local function graph_package_goal(roots)
	local published = {}
	for _, root in ipairs(roots) do
		local result = root.result
		if type(result) ~= "table" or result.type ~= "artifact" or type(result.digest) ~= "string" then
			core.goal_error(`{root.address}: package graph root must resolve to an artifact handle`)
		end
		local address = string.gsub(root.address, "^//", "")
		local directory, target = string.match(address, "^(.*):([^:]+)$")
		if target == nil then
			core.goal_error(`invalid package graph root address '{root.address}'`)
		end
		-- `result.path` is the declared output path of the artifact, so its
		-- basename is the filename that the target built. A root that
		-- publishes a subtree, or a root without a path, has no filename to
		-- keep and uses the target name.
		local filename = target
		if type(result.path) == "string" then
			local built = basename(result.path)
			if is_shared_library(built) then
				filename = built
			end
		end
		local destination = "dist/"
		if directory ~= "" then
			destination ..= directory .. "/"
		end
		destination ..= filename
		core.write_workspace(destination, result.digest, { from = result.path })
		table.insert(published, `\n  {root.address} -> {destination}`)
	end
	if #published == 0 then
		return nil
	end
	local noun = if #published == 1 then "target" else "targets"
	return `Packaged {#published} {noun}:{table.concat(published)}`
end

return {
	PACKAGE = core.goal("package", graph_package_goal),
	binary_product = binary_product,
	binary_product_layout = binary_product_layout,
	graph_package_goal = graph_package_goal,
}
