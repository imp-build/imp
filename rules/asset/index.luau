local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local native = require("@imp/rules/imp/native-tool")

local shell = native.native_tool("sh")

local function normalize_workspace_path(path)
	if string.sub(path, 1, 1) == "/" then
		error("asset paths must stay within the workspace: " .. path)
	end
	local parts = {}
	for part in string.gmatch(path, "[^/]+") do
		if part == ".." then
			error("asset paths must stay within the workspace: " .. path)
		elseif part ~= "." then
			table.insert(parts, part)
		end
	end
	if #parts == 0 then
		return "."
	end
	return table.concat(parts, "/")
end

local function source_files(options, name)
	if type(options.srcs) ~= "table" then
		error(name .. "({ srcs }) requires source glob patterns")
	end
	local base = options.base or core.package_path()
	if type(base) ~= "string" then
		error(name .. "({ base }) expects a workspace-relative string")
	end
	local path = options.path or "."
	if type(path) ~= "string" then
		error(name .. "({ path }) expects a string")
	end
	local root = base
	if path ~= "." and path ~= "" then
		root = (base == "." and path) or (path == "." and base) or (base .. "/" .. path)
	end
	return core.files({
		root = normalize_workspace_path(root),
		include = options.srcs,
		exclude = options.exclude or {},
	})
end

--- Capture a source collection and expose its BUILD workflow.
--- @param options Source globs, base, path, and exclusions.
--- @returns A table with sources and a BUILD task.
local function asset(options)
	options = options or {}
	local sources = source_files(options, "asset")
	local build_task = core.task({
		display = "bundle assets",
		cache = false,
		inputs = { sources = sources, shell = shell },
		run = function(exec, inputs)
			return exec.action({
				argv = { "sh", "-c", "true" },
				inputs = { inputs.sources },
				cache = false,
			})
		end,
	})
	return {
		sources = sources,
		BUILD = build_task,
	}
end

--- Capture resource files for use as explicit graph dependencies.
--- @param options Source globs, base, path, and exclusions.
--- @returns An asset table with a files handle.
local function resource_package(options)
	options = options or {}
	if type(options.srcs) ~= "table" or #options.srcs == 0 then
		error("resource_package({ srcs }) requires one or more source glob patterns")
	end
	local value = asset(options)
	value.files = value.sources
	return value
end

return {

	--- @category target
	asset = asset,

	--- @category target
	resource_package = resource_package,
	workflow = build.BUILD,
}
