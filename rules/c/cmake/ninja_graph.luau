-- A narrow parser for the Ninja build files that CMake generates
-- (build.ninja and rules.ninja). It gives enough data to replay each build
-- edge as its own action, so that an unchanged compile edge is a cache hit
-- and the CMake project does not rebuild as one unit.
--
-- It reads only the subset of the Ninja format that the Ninja generator of
-- CMake writes: rule and build blocks, $in, $out, edge variables, the | and
-- || dependency syntax, and `include`. It is not a general Ninja parser.
--
-- An edge is a table with `outputs`, `implicit_outputs`, `rule`, `inputs`,
-- `implicit_inputs`, `order_only`, and `vars`. A parsed graph is
-- `{ rules, edges, top_vars, target_types }`.

local function trim(value)
	return string.match(value or "", "^%s*(.-)%s*$")
end

local function starts_with(value, prefix)
	return string.sub(value, 1, #prefix) == prefix
end

local function ends_with(value, suffix)
	return suffix == "" or string.sub(value, -#suffix) == suffix
end

-- Replace each occurrence of the plain text `needle` in `text`.
local function replace_all(text, needle, replacement)
	if needle == "" then
		return text
	end
	local parts = {}
	local init = 1
	while true do
		local first, last = string.find(text, needle, init, true)
		if first == nil then
			break
		end
		table.insert(parts, string.sub(text, init, first - 1))
		table.insert(parts, replacement)
		init = last + 1
	end
	table.insert(parts, string.sub(text, init))
	return table.concat(parts)
end

local function append(list, values)
	for _, value in ipairs(values) do
		table.insert(list, value)
	end
	return list
end

local function concat_lists(...)
	local result = {}
	for _, list in ipairs({ ... }) do
		append(result, list)
	end
	return result
end

-- Ninja writes a literal `$`, `:`, or space as `$$`, `$:`, or `$ `. CMake
-- uses `$:` for Windows drive letters, for example
-- `cmake_ninja_workdir = C$:/tmp/...`. `$name` and `${name}` references stay
-- for `expand_var`.
--
-- On Windows, CMake writes some edge values (OBJECT_DIR, DEP_FILE,
-- TARGET_FILE, and compiler paths) with backslashes. A backslash that gets to
-- `sh -c` through the argv of Git for Windows becomes corrupt, so each
-- backslash becomes a forward slash. In this subset, each backslash that
-- CMake writes is a path separator.
local function unescape_ninja_value(value)
	local unescaped = string.gsub(value, "%$([%$: ])", "%1")
	return (string.gsub(unescaped, "\\", "/"))
end

local function tokenize_paths(value)
	local tokens = {}
	for token in string.gmatch(trim(value), "%S+") do
		table.insert(tokens, unescape_ninja_value(token))
	end
	return tokens
end

local function split_once(value, separator)
	local first, last = string.find(value, separator, 1, true)
	if first == nil then
		return value, ""
	end
	return string.sub(value, 1, first - 1), string.sub(value, last + 1)
end

-- CMake writes "# Object build statements for <TYPE> target <name>" or
-- "# Link build statements for <TYPE> target <name>" above the edges of a
-- target. It is the only machine-readable source of the CMake type of a
-- target.
local function target_type_comment(line)
	local kind, target_type, name = string.match(line, "^#%s*(%a+) build statements for (%S+) target (.+)$")
	if kind == "Object" or kind == "Link" then
		return target_type, name
	end
	return nil
end

local function read_block(lines, i)
	local body = {}
	while i <= #lines and starts_with(lines[i], "  ") do
		local key, value = split_once(trim(lines[i]), "=")
		body[trim(key)] = unescape_ninja_value(trim(value))
		i += 1
	end
	return body, i
end

local function parse_into(text, graph, read_include)
	local lines = string.split(text, "\n")
	local i = 1
	while i <= #lines do
		local stripped = trim(lines[i])
		if stripped == "" then
			i += 1
		elseif starts_with(stripped, "#") then
			local target_type, name = target_type_comment(stripped)
			if target_type ~= nil then
				graph.target_types[name] = target_type
			end
			i += 1
		elseif starts_with(stripped, "include ") then
			-- The MSVC generator writes this path with backslashes.
			local include_path = unescape_ninja_value(trim(string.sub(stripped, #"include " + 1)))
			parse_into(read_include(include_path), graph, read_include)
			i += 1
		elseif starts_with(stripped, "rule ") then
			local name = trim(string.sub(stripped, #"rule " + 1))
			graph.rules[name], i = read_block(lines, i + 1)
		elseif starts_with(stripped, "build ") then
			local rest = string.sub(stripped, #"build " + 1)
			local outs_part, rhs_raw = split_once(rest, ":")
			local explicit_out, implicit_out = split_once(outs_part, "|")
			local rule_and_ins, order_only = split_once(trim(rhs_raw), "||")
			local rule_name, ins_raw = split_once(trim(rule_and_ins), " ")
			local explicit_in, implicit_in = split_once(trim(ins_raw), "|")
			local vars
			vars, i = read_block(lines, i + 1)
			table.insert(graph.edges, {
				outputs = tokenize_paths(explicit_out),
				implicit_outputs = tokenize_paths(implicit_out),
				rule = trim(rule_name),
				inputs = tokenize_paths(explicit_in),
				implicit_inputs = tokenize_paths(implicit_in),
				order_only = tokenize_paths(order_only),
				vars = vars,
			})
		else
			-- A top-level "name = value" assignment.
			if string.find(stripped, "=", 1, true) then
				local key, value = split_once(stripped, "=")
				graph.top_vars[trim(key)] = unescape_ninja_value(trim(value))
			end
			i += 1
		end
	end
end

--- Parse `main_text` (normally build.ninja) and each file that it includes.
--- `read_include(path)` returns the text of an included file, so that the
--- parser works on CAS reads and on test fixtures.
local function parse_ninja(main_text, read_include)
	local graph = { rules = {}, edges = {}, top_vars = {}, target_types = {} }
	parse_into(main_text, graph, read_include)
	return graph
end

--- Resolve $in, $out, and $VAR references in `template`. The edge variables
--- come first, then the rule defaults, then the top-level variables, as
--- Ninja scopes them in the subset that CMake writes.
---
--- `$in_newline` and `$out_newline` are Ninja builtins. The MSVC
--- static-library rule uses `rspfile_content = $in_newline $LINK_FLAGS`.
--- They join with a space, not a newline: replay writes the response file
--- through argv elements of `sh`, and the argv of Git for Windows removes
--- newline bytes. lib.exe and link.exe read spaces and newlines as the same
--- separator.
local function expand_var(template, edge, top_vars, rule_defaults)
	return (
		string.gsub(template, "%${?([%w_]+)}?", function(name)
			if name == "in" or name == "in_newline" then
				return table.concat(edge.inputs, " ")
			end
			if name == "out" or name == "out_newline" then
				return table.concat(edge.outputs, " ")
			end
			if edge.vars[name] ~= nil then
				return expand_var(edge.vars[name], edge, top_vars, rule_defaults)
			end
			if rule_defaults[name] ~= nil then
				return rule_defaults[name]
			end
			if top_vars[name] ~= nil then
				return top_vars[name]
			end
			return ""
		end)
	)
end

local function edge_outputs(edge)
	return concat_lists(edge.outputs, edge.implicit_outputs)
end

local function edge_dependencies(edge)
	return concat_lists(edge.inputs, edge.implicit_inputs, edge.order_only)
end

local function edges_by_output(edges)
	local by_output = {}
	for _, edge in ipairs(edges) do
		for _, path in ipairs(edge_outputs(edge)) do
			by_output[path] = edge
		end
	end
	return by_output
end

--- The edges that `target_names` need, in dependency order. A dependency
--- path in the set `boundary_outputs` stops the walk: the walk records it
--- and does not visit its edge.
---
--- `boundary_outputs` holds the final outputs of the other named CMake
--- targets. CMake names that path in a `|` or `||` reference when one target
--- depends on another, for example `|| libcrypto.a` on a library link edge
--- or `| libssl.a libcrypto.a` on an executable link edge. The other target
--- has its own replay task, so this walk does not derive its edges again.
---
--- Returns `{ edges, boundaries }`.
local function reachable_edges_bounded(edges, target_names, boundary_outputs)
	local by_output = edges_by_output(edges)
	local visited = {}
	local order = {}
	local boundaries = {}
	local seen_boundaries = {}

	local function visit(edge)
		if visited[edge] then
			return
		end
		visited[edge] = true
		for _, dep in ipairs(edge_dependencies(edge)) do
			if boundary_outputs[dep] then
				if not seen_boundaries[dep] then
					seen_boundaries[dep] = true
					table.insert(boundaries, dep)
				end
				continue
			end
			local dep_edge = by_output[dep]
			if dep_edge ~= nil then
				visit(dep_edge)
			end
		end
		table.insert(order, edge)
	end

	for _, name in ipairs(target_names) do
		local edge = by_output[name]
		if edge ~= nil then
			visit(edge)
		end
	end
	return { edges = order, boundaries = boundaries }
end

--- The edges that `target_names` need, in dependency order (for example
--- from "all"). CMake bookkeeping edges, such as build.ninja regeneration
--- and clean, are not reached.
local function reachable_edges(edges, target_names)
	return reachable_edges_bounded(edges, target_names, {}).edges
end

local COMMAND_OPERATORS = { "&&", "||", ";", "(" }
local TOOL_PATH_CHARS = "[^%s&|;()'\"]+"

-- Find each path in command position: at the start of `command`, or after
-- `&&`, `||`, `;`, or `(`, then optional whitespace. `match_path(command, i)`
-- returns the last index of a path that starts at `i` and a value, or nil.
-- `replace(prefix, value)` gives the text for the prefix and the path.
local function rewrite_command_positions(command, match_path, replace)
	local parts = {}
	local copied = 1
	local i = 1
	while i <= #command do
		local prefixes = {}
		if i == 1 then
			table.insert(prefixes, "")
		end
		for _, operator in ipairs(COMMAND_OPERATORS) do
			if string.sub(command, i, i + #operator - 1) == operator then
				table.insert(prefixes, operator)
			end
		end
		local matched = false
		for _, prefix in ipairs(prefixes) do
			local _, spaces_end = string.find(command, "^%s*", i + #prefix)
			local path_end, value = match_path(command, spaces_end + 1)
			if path_end ~= nil then
				table.insert(parts, string.sub(command, copied, i - 1))
				table.insert(parts, replace(prefix, value))
				copied = path_end + 1
				i = path_end + 1
				matched = true
				break
			end
		end
		if not matched then
			i += 1
		end
	end
	table.insert(parts, string.sub(command, copied))
	return table.concat(parts)
end

local function last_segment(path)
	local segments = string.split(path, "/")
	return segments[#segments]
end

local function with_prefix(prefix, base)
	return if #prefix > 0 then `{prefix} {base}` else base
end

-- A path through the tool mount of Imp, for example ".imp/tools/zig/zig"
-- or "../../.imp/tools/zig/zigranlib", that CMake found at configure time.
-- It is not a host binary, so its name is not a tool name.
local function match_imp_mount_tool(command, i)
	local j = i
	while string.sub(command, j, j + 2) == "../" do
		j += 3
	end
	local mount = ".imp/tools/"
	if string.sub(command, j, j + #mount - 1) ~= mount then
		return nil
	end
	local rest = string.match(command, "^" .. TOOL_PATH_CHARS, j + #mount)
	if rest == nil then
		return nil
	end
	return j + #mount + #rest - 1, rest
end

-- An absolute Unix path, or a Windows drive path (`C:/...` after
-- `unescape_ninja_value`). gcc on Windows writes
-- `-DCMAKE_C_COMPILER=C:/Users/.../clang.exe` into the build files.
local function match_host_absolute_tool(command, i)
	local path = string.match(command, "^/" .. TOOL_PATH_CHARS, i)
		or string.match(command, "^%a:[\\/]" .. TOOL_PATH_CHARS, i)
	if path == nil then
		return nil
	end
	return i + #path - 1, path
end

--- Rewrite each tool in command position to its bare name, so that the tools
--- of the replay action resolve it through PATH. An absolute host path, such
--- as "/usr/bin/cc", is not present in a sandbox. Argument paths, such as
--- "-I/abs/inc", stay.
---
--- Returns `{ command, tool_names }`. `tool_names` has the bare names of the
--- absolute host paths, in first-use order. A path through the Imp tool
--- mount is rewritten but not added, because the mount of its tool already
--- covers it.
local function rewrite_tool_invocations(command)
	local tool_names = {}
	local seen = {}
	local rewritten = rewrite_command_positions(command, match_imp_mount_tool, function(prefix, rest)
		return with_prefix(prefix, last_segment(rest))
	end)
	rewritten = rewrite_command_positions(rewritten, match_host_absolute_tool, function(prefix, path)
		local base = last_segment(path)
		if not seen[base] then
			seen[base] = true
			table.insert(tool_names, base)
		end
		return with_prefix(prefix, base)
	end)
	return { command = rewritten, tool_names = tool_names }
end

--- The sandbox root of the configure action. CMake makes the source and
--- build directories absolute, so each generated path starts with that root,
--- which a later replay sandbox does not have. CMake writes the absolute
--- build directory as `cmake_ninja_workdir`. With the workspace-relative
--- build directory, that gives the root. Returns nil when they do not agree.
local function sandbox_root_from_workdir(cmake_ninja_workdir, build_dir_path)
	if cmake_ninja_workdir == nil then
		return nil
	end
	local workdir = string.gsub(cmake_ninja_workdir, "/+$", "")
	local suffix = `/{build_dir_path}`
	if not ends_with(workdir, suffix) then
		return nil
	end
	return string.sub(workdir, 1, #workdir - #suffix)
end

-- Ninja runs commands in the build directory, so a replayed command does
-- too. A path rebased from the configure sandbox must thus be relative to
-- the build directory: one "../" for each part of `build_dir_path`.
local function up_prefix_for_build_dir(build_dir_path)
	local depth = 0
	for _, part in ipairs(string.split(build_dir_path, "/")) do
		if part ~= "" and part ~= "." then
			depth += 1
		end
	end
	return string.rep("../", depth)
end

--- Replace the configure sandbox root and its slash in `text` with
--- `replacement`.
local function rebase_absolute_paths(text, sandbox_root, replacement)
	if sandbox_root == nil then
		return text
	end
	return replace_all(text, sandbox_root .. "/", replacement or "")
end

-- On Windows, CMake puts a link command in `cmd.exe /C "..."`, and a
-- POST_BUILD step can add another wrapper inside it. Replay runs each
-- command through `sh -c`, which has no cmd.exe, so each wrapper and each
-- double quote goes. A command that CMake writes has no double quote that
-- must stay. `cd /D <dir>` becomes `cd <dir>`, because the `cd` of sh has no
-- `/D` flag.
local function strip_cmd_exe_wrapper(command)
	local stripped = string.gsub(command, "cmd%.exe%s+/[Cc]%s+", "")
	stripped = string.gsub(stripped, "cmd%s+/[Cc]%s+", "")
	stripped = string.gsub(stripped, "%f[%w_]cd%s+/[Dd]%s+", "cd ")
	return (string.gsub(stripped, '"', ""))
end

--- Rebase one path token of an edge input or output list: remove the
--- configure sandbox root. These paths are relative to the workspace, not to
--- the directory where the command runs.
local function rebase_path(path, sandbox_root)
	if sandbox_root ~= nil and starts_with(path, sandbox_root .. "/") then
		return string.sub(path, #sandbox_root + 2)
	end
	return path
end

-- Ninja writes `rspfile_content` to the `rspfile` path before it runs the
-- command. Replay does not run Ninja, so the caller writes the file. CMake
-- uses this for the static-library rules, for example BoringSSL's
-- `RSP_FILE = CMakeFiles/crypto.rsp`. The path is relative to the build
-- directory, as $out is. Only the content can have configure sandbox paths.
local function resolve_edge_rspfile(edge, rule, top_vars, sandbox_root, build_dir_path)
	if rule.rspfile == nil or rule.rspfile == "" then
		return nil
	end
	local path = expand_var(rule.rspfile, edge, top_vars, rule)
	local raw_content = string.gsub(expand_var(rule.rspfile_content or "", edge, top_vars, rule), "\\", "/")
	return {
		path = path,
		content = rebase_absolute_paths(raw_content, sandbox_root, up_prefix_for_build_dir(build_dir_path)),
	}
end

--- Resolve one edge to a shell command that runs in `build_dir_path`, as
--- Ninja runs it. Configure sandbox paths become relative to the build
--- directory, and tool paths become bare names (see
--- `rewrite_tool_invocations`).
---
--- Returns `{ command, tool_names, rspfile }`, or nil when the rule has no
--- command. `rspfile` is `{ path, content }` or nil.
local function resolve_edge_command(edge, rules, top_vars, sandbox_root, build_dir_path)
	local rule = rules[edge.rule]
	if rule == nil or rule.command == nil or rule.command == "" then
		return nil
	end
	-- MSVC also writes backslashes in relative flag values, for example
	-- `/FoCMakeFiles\hello_cmake.dir\hello.c.obj`. sh would read `\h` as `h`.
	local expanded = string.gsub(expand_var(rule.command, edge, top_vars, rule), "\\", "/")
	local rebased = rebase_absolute_paths(expanded, sandbox_root, up_prefix_for_build_dir(build_dir_path))
	local rewritten = rewrite_tool_invocations(strip_cmd_exe_wrapper(rebased))
	return {
		command = rewritten.command,
		tool_names = rewritten.tool_names,
		rspfile = resolve_edge_rspfile(edge, rule, top_vars, sandbox_root, build_dir_path),
	}
end

--- Join a path that is relative to `base_dir` onto it, and resolve `.` and
--- `..` parts. The result is relative to the workspace.
local function join_and_normalize(base_dir, relative_path)
	local stack = {}
	for _, part in ipairs(string.split(base_dir, "/")) do
		if part ~= "" and part ~= "." then
			table.insert(stack, part)
		end
	end
	for _, part in ipairs(string.split(relative_path, "/")) do
		if part == "" or part == "." then
			continue
		end
		if part == ".." then
			table.remove(stack)
		else
			table.insert(stack, part)
		end
	end
	return table.concat(stack, "/")
end

-- Only these target types have one build artifact to give as a target.
-- OBJECT_LIBRARY has no link step, INTERFACE_LIBRARY has no output, and
-- UTILITY targets have no single known output. Replay still builds them when
-- a named target needs them.
local REAL_TARGET_TYPES = table.freeze({
	STATIC_LIBRARY = true,
	SHARED_LIBRARY = true,
	MODULE_LIBRARY = true,
	EXECUTABLE = true,
})

local function is_command_edge(edge, rules)
	local rule = rules[edge.rule]
	return edge.rule ~= "phony" and rule ~= nil and rule.command ~= nil and rule.command ~= ""
end

--- The named CMake targets of `graph` that have a real artifact, as
--- `{ name, outputs, type }` entries sorted by name.
---
--- CMake writes the scratch directory `CMakeFiles/<name>.dir/` of a target
--- into the variables of its edges (OBJECT_DIR, DEP_FILE, ...). That finds
--- each target, also an executable that has no phony alias. A name must
--- reach at least one edge with a command. `outputs` has only the final
--- products: an output that another reached edge reads, such as an object
--- file, is not a product.
local function list_named_cmake_targets(graph)
	local names = {}
	local seen = {}
	for _, edge in ipairs(graph.edges) do
		for _, value in pairs(edge.vars) do
			local name = string.match(value, "CMakeFiles/([^/]+)%.dir/")
			if name ~= nil and not seen[name] then
				seen[name] = true
				table.insert(names, name)
			end
		end
	end
	table.sort(names)

	local named = {}
	for _, name in ipairs(names) do
		local target_type = graph.target_types[name]
		if not REAL_TARGET_TYPES[target_type] then
			continue
		end
		local reached = {}
		for _, edge in ipairs(reachable_edges(graph.edges, { name })) do
			if is_command_edge(edge, graph.rules) then
				table.insert(reached, edge)
			end
		end
		if #reached == 0 then
			continue
		end
		local consumed = {}
		for _, edge in ipairs(reached) do
			for _, path in ipairs(edge_dependencies(edge)) do
				consumed[path] = true
			end
		end
		local outputs = {}
		local added = {}
		for _, edge in ipairs(reached) do
			for _, path in ipairs(edge_outputs(edge)) do
				if not consumed[path] and not added[path] then
					added[path] = true
					table.insert(outputs, path)
				end
			end
		end
		table.insert(named, { name = name, outputs = outputs, type = target_type })
	end
	return named
end

--- The destinations of `cmake -E copy` and `cmake -E copy_if_different` in a
--- resolved command, relative to the workspace.
---
--- A POST_BUILD or PRE_BUILD custom command can copy a built artifact, for
--- example into the source tree. The Ninja graph has no edge for that copy,
--- so replay finds the copy command and captures its destination as an
--- extra output of the edge.
local function extract_copy_destinations(command, build_dir_path)
	local destinations = {}
	local seen = {}
	local init = 1
	while true do
		local first, last = string.find(command, "%f[%w_]cmake%s+%-E%s+copy", init)
		if first == nil then
			break
		end
		local j = last + 1
		if string.sub(command, j, j + 12) == "_if_different" then
			j += 13
		end
		local _, match_end, _, dest = string.find(command, "^%s+(%S+)%s+(%S+)", j)
		if match_end == nil then
			init = first + 1
			continue
		end
		dest = string.gsub(string.gsub(dest, "^['\"]", ""), "['\"]$", "")
		local path = join_and_normalize(build_dir_path, dest)
		if not seen[path] then
			seen[path] = true
			table.insert(destinations, path)
		end
		init = match_end + 1
	end
	return destinations
end

return {
	edge_dependencies = edge_dependencies,
	edge_outputs = edge_outputs,
	expand_var = expand_var,
	extract_copy_destinations = extract_copy_destinations,
	is_command_edge = is_command_edge,
	join_and_normalize = join_and_normalize,
	list_named_cmake_targets = list_named_cmake_targets,
	parse_ninja = parse_ninja,
	reachable_edges = reachable_edges,
	reachable_edges_bounded = reachable_edges_bounded,
	rebase_absolute_paths = rebase_absolute_paths,
	rebase_path = rebase_path,
	replace_all = replace_all,
	resolve_edge_command = resolve_edge_command,
	rewrite_tool_invocations = rewrite_tool_invocations,
	sandbox_root_from_workdir = sandbox_root_from_workdir,
}
