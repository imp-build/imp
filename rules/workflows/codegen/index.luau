-- The `codegen` goal exports the files of the selected `codegen()` roots
-- below `dist/codegen/`. Each file keeps its declared workspace-relative path.
--
-- A `CODEGEN` root is the generator task of a `codegen()` result from
-- @imp/rules/imp/codegen. It resolves to its artifact outputs, and the path
-- of each artifact is its declared output path.
local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")

local function is_workspace_relative_file(path)
	if type(path) ~= "string" or #path == 0 then
		return false
	end
	if string.sub(path, 1, 1) == "/" or string.find(path, "\\", 1, true) or string.match(path, "^%a:") then
		return false
	end
	for part in string.gmatch(path .. "/", "([^/]*)/") do
		if part == "" or part == "." or part == ".." then
			return false
		end
	end
	return true
end

-- Reject paths that differ only in case on each host, so that one selection
-- gives the same result on case-sensitive and case-insensitive filesystems.
local function collision_key(path)
	return string.lower(path)
end

local function find_path_conflict(owners, key)
	local parts = string.split(key, "/")
	for last = 1, #parts - 1 do
		local owner = owners[table.concat(parts, "/", 1, last)]
		if owner ~= nil then
			return owner
		end
	end
	local prefix = key .. "/"
	for existing, owner in pairs(owners) do
		if string.sub(existing, 1, #prefix) == prefix then
			return owner
		end
	end
	return owners[key]
end

--- Write the files of the selected codegen roots below `dist/codegen/`, and
--- return a report.
local function graph_codegen_goal(roots)
	local outputs = {}
	local owners = {}
	for _, root in ipairs(roots) do
		local address = root.address
		local files = generate.generated_root_files(root.result)
		if files == nil then
			core.goal_error(`{address}: codegen root must resolve to a codegen() result`)
		end
		for _, file in ipairs(files) do
			local path = file.path
			if not is_workspace_relative_file(path) then
				core.goal_error(`{address}: codegen output path '{path}' must be a normalized workspace-relative path`)
			end
			local destination = `dist/codegen/{path}`
			local key = collision_key(destination)
			local owner = find_path_conflict(owners, key)
			if owner ~= nil then
				core.goal_error(
					`codegen output path conflict at '{destination}': {owner.address} `
						.. `({owner.path}) and {address} ({path})`
				)
			end
			owners[key] = { address = address, path = path }
			table.insert(outputs, { address = address, path = path, destination = destination, digest = file.digest })
		end
	end

	for _, item in ipairs(outputs) do
		core.write_workspace(item.destination, item.digest, { from = item.path })
	end
	if #outputs == 0 then
		return nil
	end
	local lines = { `Exported {#outputs} codegen file{if #outputs == 1 then "" else "s"}:` }
	for _, item in ipairs(outputs) do
		table.insert(lines, `  {item.address}: {item.path} -> {item.destination}`)
	end
	return table.concat(lines, "\n")
end

return {
	CODEGEN = core.goal("codegen", graph_codegen_goal),
	graph_codegen_goal = graph_codegen_goal,
}
