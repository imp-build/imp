local core = require("@imp/core")

local function basename(path)
	local name = string.match(path, "([^/]+)$")
	return name or path
end

local function is_shared_library(path)
	local name = string.lower(path)
	return string.match(name, "%.so$") ~= nil
		or string.match(name, "%.so%.%d+$") ~= nil
		or string.match(name, "%.dylib$") ~= nil
		or string.match(name, "%.dll$") ~= nil
end

local function graph_package_goal(roots)
	for _, root in ipairs(roots) do
		local result = root.result
		if type(result) ~= "table" or result.type ~= "artifact" or type(result.digest) ~= "string" then
			error(root.address .. ": package graph root must resolve to an artifact handle")
		end
		local address = string.gsub(root.address, "^//", "")
		local directory, target = string.match(address, "^(.*):([^:]+)$")
		if target == nil then
			error("invalid package graph root address '" .. root.address .. "'")
		end
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
	end
end

return {
	PACKAGE = core.goal("package", graph_package_goal),
}
