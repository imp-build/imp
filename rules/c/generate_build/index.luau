-- The C and C++ BUILD generator for the `generate-build` goal.
--
-- The generator finds each unowned CMakeLists.txt and each unowned C or C++
-- source directory in the workspace. For each one, it gives a
-- `cmake_project`, `cc_binary`, or `cc_library` target in a generated
-- `BUILD.luau` file. A directory that a declared `cc_library`, `cc_binary`,
-- or `cmake_project` already uses gets no target. A source directory below
-- an unowned CMake project gets no target, because the CMake project builds
-- it. A source directory gets `cc_binary` when one of its sources defines
-- `main`.
--
-- The generator runs only when the `build_generate` field of the `c`
-- configuration namespace is true.
local core = require("@imp/core")
local c = require("@imp/rules/c")
local cmake = require("@imp/rules/c/cmake")

core.register_build_rule({ rule = "cc_library", module = "@imp/rules/c" })
core.register_build_rule({ rule = "cc_binary", module = "@imp/rules/c" })
core.register_build_rule({ rule = "cmake_project", module = "@imp/rules/c/cmake" })

--- The configuration schema of the `c` namespace. `build_generate` enables
--- the generator. The default is false.
local C_CONFIG_SCHEMA = table.freeze({
	build_generate = core.field.bool({ default = false }),
})

core.define_config_schema("c", C_CONFIG_SCHEMA)

local DEFAULT_GENERATE_BUILD_EXCLUDES = table.freeze({
	"**/.*/**",
	"**/build/**",
	"**/coverage/**",
	"**/dist/**",
	"**/obj/**",
	"**/target/**",
	"**/vendor/**",
})

local SOURCE_EXTENSIONS = table.freeze({ c = true, cc = true, cpp = true, cxx = true })

-- Luau keywords. A generated target name must not be one of them.
local KEYWORDS = table.freeze({
	["and"] = true,
	["break"] = true,
	["continue"] = true,
	["do"] = true,
	["else"] = true,
	["elseif"] = true,
	["end"] = true,
	["export"] = true,
	["false"] = true,
	["for"] = true,
	["function"] = true,
	["if"] = true,
	["in"] = true,
	["local"] = true,
	["nil"] = true,
	["not"] = true,
	["or"] = true,
	["repeat"] = true,
	["return"] = true,
	["then"] = true,
	["true"] = true,
	["type"] = true,
	["until"] = true,
	["while"] = true,
})

local function recursive_patterns(patterns)
	local result = {}
	for _, pattern in ipairs(patterns) do
		table.insert(result, `**/{pattern}`)
	end
	return result
end

local function normalize_workspace_path(path)
	local parts = {}
	for part in string.gmatch(path, "[^/]+") do
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end

local function dirname(path)
	return string.match(path, "^(.*)/[^/]*$") or "."
end

local function basename(path)
	return string.match(path, "[^/]*$")
end

local function build_file_for_dir(dir)
	return if dir == "." then "BUILD.luau" else `{dir}/BUILD.luau`
end

--- Make a Luau identifier from `raw`. The generated BUILD renderer accepts
--- only identifiers that are not keywords.
local function sanitize_identifier(raw)
	local name = string.gsub(raw, "[^%w_]", "_")
	if name == "" then
		name = "root"
	end
	if not string.match(name, "^[%a_]") or KEYWORDS[name] then
		name = `_{name}`
	end
	return name
end

local function target_name_for_dir(dir)
	if dir == "." then
		return "root"
	end
	return sanitize_identifier(basename(dir))
end

local function append_build_target(result, file, target)
	if result[file] == nil then
		result[file] = {}
	end
	table.insert(result[file], target)
end

local function source_ext(path)
	local found = string.match(path, "%.([^./]+)$")
	return if found then string.lower(found) else ""
end

local function is_source(path)
	return SOURCE_EXTENSIONS[source_ext(path)] == true
end

--- Replace each C comment and each string or character literal in `input`
--- with spaces. Keep each newline. Block comments can be nested.
local function strip_c_comments_and_strings(input)
	local out = {}
	local i = 1
	local length = #input
	local in_string = false
	local in_char = false
	local in_line_comment = false
	local block_depth = 0

	while i <= length do
		local ch = string.sub(input, i, i)
		local next = string.sub(input, i + 1, i + 1)

		if in_line_comment then
			if ch == "\n" then
				in_line_comment = false
				table.insert(out, "\n")
			else
				table.insert(out, " ")
			end
			i += 1
		elseif block_depth > 0 then
			if ch == "/" and next == "*" then
				block_depth += 1
				table.insert(out, "  ")
				i += 2
			elseif ch == "*" and next == "/" then
				block_depth -= 1
				table.insert(out, "  ")
				i += 2
			else
				table.insert(out, if ch == "\n" then "\n" else " ")
				i += 1
			end
		elseif not in_string and not in_char and ch == "/" and next == "/" then
			in_line_comment = true
			table.insert(out, "  ")
			i += 2
		elseif not in_string and not in_char and ch == "/" and next == "*" then
			block_depth = 1
			table.insert(out, "  ")
			i += 2
		elseif in_string or in_char then
			table.insert(out, if ch == "\n" then "\n" else " ")
			if ch == "\\" and next ~= "" then
				table.insert(out, if next == "\n" then "\n" else " ")
				i += 2
			else
				if in_string and ch == '"' then
					in_string = false
				end
				if in_char and ch == "'" then
					in_char = false
				end
				i += 1
			end
		elseif ch == '"' then
			in_string = true
			table.insert(out, " ")
			i += 1
		elseif ch == "'" then
			in_char = true
			table.insert(out, " ")
			i += 1
		else
			table.insert(out, ch)
			i += 1
		end
	end

	return table.concat(out)
end

--- Return true when the C or C++ source text calls or defines `main(`
--- outside comments and string or character literals.
local function has_c_main_entrypoint(source_text)
	local text = strip_c_comments_and_strings(source_text)
	return string.find(text, "%f[%w_]main%s*%(") ~= nil
end

local function path_is_under(path, root)
	local normalized_path = normalize_workspace_path(path)
	local normalized_root = normalize_workspace_path(root)
	if normalized_root == "." then
		return normalized_path ~= "."
	end
	return normalized_path == normalized_root
		or string.sub(normalized_path, 1, #normalized_root + 1) == `{normalized_root}/`
end

local function source_has_main(path)
	return is_source(path) and has_c_main_entrypoint(core.read_file(`@workspace/{path}`) or "")
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

--- Give the generated BUILD targets for the unowned C, C++, and CMake
--- sources below `root`.
---
--- Options:
---   root     The workspace directory to search. The default is ".".
---   exclude  Glob patterns to skip. The default skips hidden directories
---            and the build, coverage, dist, obj, target, and vendor
---            directories.
---
--- The result maps each `BUILD.luau` path to a list of `{ name, rule, props }`
--- targets.
local function generate_build(options)
	options = options or {}
	local include = { "**/CMakeLists.txt" }
	for _, pattern in ipairs(recursive_patterns(c.DEFAULT_CPP_SRCS)) do
		table.insert(include, pattern)
	end
	for _, pattern in ipairs(recursive_patterns(c.DEFAULT_CPP_HDRS)) do
		table.insert(include, pattern)
	end
	local files = core.all_unowned({
		root = options.root or ".",
		include = include,
		exclude = options.exclude or DEFAULT_GENERATE_BUILD_EXCLUDES,
	})

	local existing_paths = {}
	for _, spec in ipairs(c.cc_workload_specs()) do
		existing_paths[normalize_workspace_path(spec.path)] = true
	end
	for _, spec in ipairs(cmake.cmake_project_specs()) do
		existing_paths[normalize_workspace_path(spec.path)] = true
	end

	local cmake_lists = {}
	for _, path in ipairs(files) do
		if basename(path) == "CMakeLists.txt" then
			table.insert(cmake_lists, dirname(path))
		end
	end
	local cmake_dirs = sorted_unique(cmake_lists)

	local result = {}
	local cmake_roots = {}
	for _, dir in ipairs(cmake_dirs) do
		if not existing_paths[normalize_workspace_path(dir)] then
			table.insert(cmake_roots, dir)
			append_build_target(result, build_file_for_dir(dir), {
				name = `{target_name_for_dir(dir)}_cmake`,
				rule = "cmake_project",
				props = {},
			})
		end
	end

	local raw_sources = {}
	for _, path in ipairs(files) do
		if is_source(path) then
			local under_cmake = false
			for _, cmake_root in ipairs(cmake_roots) do
				if path_is_under(path, cmake_root) then
					under_cmake = true
					break
				end
			end
			if not under_cmake then
				table.insert(raw_sources, path)
			end
		end
	end

	local raw_source_dirs = {}
	for _, path in ipairs(raw_sources) do
		table.insert(raw_source_dirs, dirname(path))
	end
	for _, dir in ipairs(sorted_unique(raw_source_dirs)) do
		if not existing_paths[normalize_workspace_path(dir)] then
			local has_main = false
			for _, path in ipairs(raw_sources) do
				if dirname(path) == dir and source_has_main(path) then
					has_main = true
					break
				end
			end
			append_build_target(result, build_file_for_dir(dir), {
				name = target_name_for_dir(dir),
				rule = if has_main then "cc_binary" else "cc_library",
				props = {},
			})
		end
	end

	return result
end

core.register_build_generator({ namespace = "c", generate = generate_build })

return {
	C_CONFIG_SCHEMA = C_CONFIG_SCHEMA,
	generate_build = generate_build,
	has_c_main_entrypoint = has_c_main_entrypoint,
}
