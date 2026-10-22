-- Python project and uv workspace identity.
local core = require("@imp/core")
local function normalize(path)
	assert(type(path) == "string" and path ~= "", "Python paths require a workspace-relative path")
	local parts = {}
	for part in string.gmatch(path, "[^/]+") do
		assert(part ~= "..", `Python paths must stay in the workspace: {path}`)
		if part ~= "." then table.insert(parts, part) end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end
local function workspace_ref(path)
	return table.freeze({ __python_workspace = true, path = normalize(path) })
end
--- Declare a member project. Options: workspace and path (the BUILD package).
local function python_project(options)
	options = options or {}
	local workspace = options.workspace
	assert(type(workspace) == "table" and workspace.__python_workspace == true, "python_project({ workspace }) expects python_workspace(...)")
	local path = normalize(options.path or core.package_path())
	if path == "." then path = workspace.path
	elseif workspace.path ~= "." and path ~= workspace.path and string.sub(path, 1, #workspace.path + 1) ~= workspace.path .. "/" then path = workspace.path .. "/" .. path end
	return table.freeze({ __python_project = true, path = path, workspace = workspace_ref(workspace.path) })
end
local function ancestors(path)
	local result = {}
	local current = normalize(path)
	while true do
		table.insert(result, current)
		if current == "." then break end
		current = string.match(current, "^(.*)/[^/]+$") or "."
	end
	return result
end
local function manifest(path)
	return core.read_file("@workspace/" .. (if path == "." then "pyproject.toml" else path .. "/pyproject.toml"))
end
local function find_python_project(path)
	local project_path = nil
	for _, candidate in ipairs(ancestors(path)) do
		if manifest(candidate) then project_path = candidate break end
	end
	if project_path == nil then return nil end
	local workspace_path = project_path
	for _, candidate in ipairs(ancestors(project_path)) do
		local text = manifest(candidate)
		if text then
			for line in string.gmatch(text .. "\n", "([^\n]*)\n") do
				if string.match(line, "^%s*%[tool%.uv%.workspace%]%s*#") or string.match(line, "^%s*%[tool%.uv%.workspace%]%s*$") then
					workspace_path = candidate
					return table.freeze({ __python_project = true, path = project_path, workspace = workspace_ref(workspace_path) })
				end
			end
		end
	end
	return table.freeze({ __python_project = true, path = project_path, workspace = workspace_ref(workspace_path) })
end
local function infer_python_project(path, api)
	return assert(find_python_project(path), `No pyproject.toml found at or above Python target '{path}'. Pass project: python_project(...) to {api}().`)
end
local function assert_python_project(project, api)
	assert(type(project) == "table" and project.__python_project == true, `{api}({ project }) expects python_project(...)`)
	return project
end
local function workspace_sources(workspace)
	return core.files({ root = workspace.path, include = { "pyproject.toml", "**/pyproject.toml", "uv.lock" } })
end
return { python_project = python_project, python_workspace_ref = workspace_ref, find_python_project = find_python_project,
	infer_python_project = infer_python_project, assert_python_project = assert_python_project, python_workspace_sources = workspace_sources }
