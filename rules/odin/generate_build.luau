-- BUILD generation uses the package rule's import inference. It needs no
-- serialized target references between the generated declarations.
local core = require("@imp/core")
local graph = require("@imp/rules/odin/graph")
local KEYWORDS = {}
for word in string.gmatch("and break continue do else elseif end export false for function if in local nil not or repeat return then true type until while", "%S+") do KEYWORDS[word] = true end
local function name_for(path)
	local name = string.gsub(string.match(path, "[^/]+$") or "root", "[^%w_]", "_")
	if name == "" or name == "." then name = "root" end
	if string.match(name, "^%d") or KEYWORDS[name] then name = "_" .. name end
	return name
end
--- Return generated package declarations for unowned Odin source directories.
local function generate_build(options)
	options = options or {}
	local files = core.all_unowned({ root = options.root or ".", include = { "**/*.odin" },
		exclude = options.exclude or { "**/.*/**", "**/build/**", "**/coverage/**", "**/dist/**", "**/obj/**", "**/target/**", "**/vendor/**" } })
	local normal, tests, existing = {}, {}, {}
	for _, spec in ipairs(graph.package_specs()) do existing[spec.path] = true end
	for _, path in ipairs(files) do
		local dir, name = graph.dirname(path), string.match(path, "[^/]+$")
		if string.match(name, "_test%.odin$") or string.match(name, "^test_") then tests[dir] = true else normal[dir] = true end
	end
	local result = {}
	local function add(dir, testing)
		local file = if dir == "." then "BUILD.luau" else dir .. "/BUILD.luau"
		result[file] = result[file] or {}
		local props = if testing then { srcs = { "*.odin" }, exclude = {} } else { srcs = { "*.odin" } }
		table.insert(result[file], { name = name_for(if dir == "." then "root" else dir) .. (if testing and normal[dir] then "_test" else ""),
			rule = if testing then "odin_test_package" else "odin_package", props = props })
	end
	local dirs = {} for dir in pairs(normal) do table.insert(dirs, dir) end table.sort(dirs)
	for _, dir in ipairs(dirs) do if not existing[dir] then add(dir, false) end end
	dirs = {} for dir in pairs(tests) do table.insert(dirs, dir) end table.sort(dirs)
	for _, dir in ipairs(dirs) do if not existing[dir] then add(dir, true) end end
	return result
end
core.register_build_generator({ namespace = "odin", generate = generate_build })
return { generate_build = generate_build }
