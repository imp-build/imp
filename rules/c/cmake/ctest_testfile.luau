-- A narrow parser for the CTestTestfile.cmake files that CMake generates. It
-- reads only the subset that the CTest integration of CMake writes, not the
-- CMake language:
--
--   - `add_test(name command args...)` gives the test name and command.
--   - `subdirs("dir")` gives a subdirectory that has its own
--     CTestTestfile.cmake.
--
-- Each other line, for example `set_tests_properties`, is ignored.
--
-- CMake writes three token forms for arguments:
--   - bracket-quoted:  [=[literal content]=]  (zero or more '=')
--   - double-quoted:   "content"
--   - bare:            ends at whitespace or ')'
--
-- The command can be an absolute path (the modern `add_test(NAME ...
-- COMMAND target)` form, which CMake resolves) or a bare token (the old
-- `add_test(name cmd args...)` form, which ctest resolves from its build
-- directory). The caller correlates each form to a target.

local function is_space(char)
	return string.find(char, "^%s$") ~= nil
end

-- Read the arguments that start at `start` and end at the closing ')'.
-- Returns the tokens and the index after the ')'.
local function tokenize_args(text, start)
	local tokens = {}
	local i = start
	local length = #text
	while i <= length do
		while i <= length and is_space(string.sub(text, i, i)) do
			i += 1
		end
		if i > length then
			break
		end
		local char = string.sub(text, i, i)
		if char == ")" then
			i += 1
			break
		end
		if char == "[" then
			local eqs = string.match(text, "^%[(=*)%[", i)
			if eqs ~= nil then
				local closer = `]{eqs}]`
				local content_start = i + #eqs + 2
				local close_index = string.find(text, closer, content_start, true)
				local stop = if close_index ~= nil then close_index - 1 else length
				table.insert(tokens, string.sub(text, content_start, stop))
				i = if close_index ~= nil then close_index + #closer else length + 1
				continue
			end
		end
		if char == '"' then
			local j = i + 1
			local parts = {}
			while j <= length and string.sub(text, j, j) ~= '"' do
				local current = string.sub(text, j, j)
				if current == "\\" and j < length then
					table.insert(parts, string.sub(text, j + 1, j + 1))
					j += 2
				else
					table.insert(parts, current)
					j += 1
				end
			end
			table.insert(tokens, table.concat(parts))
			i = j + 1
			continue
		end
		local j = i
		while j <= length do
			local current = string.sub(text, j, j)
			if is_space(current) or current == ")" then
				break
			end
			j += 1
		end
		table.insert(tokens, string.sub(text, i, j - 1))
		i = j
	end
	return tokens, i
end

-- Find each `<command>\s*(` call in `text`, case-insensitive. `command` is
-- lowercase. Calls `visit(tokens)` for each call.
local function each_call(text, command, visit)
	local lower = string.lower(text)
	local init = 1
	while true do
		local first, last = string.find(lower, command .. "%s*%(", init)
		if first == nil then
			return
		end
		local tokens, next_index = tokenize_args(text, last + 1)
		visit(tokens)
		init = math.max(next_index, last + 1)
	end
end

--- The `add_test()` calls of `text`, as `{ name, command }` entries.
--- `command` is the list of the command and its arguments.
local function parse_ctest_testfile(text)
	local tests = {}
	each_call(text, "add_test", function(tokens)
		if #tokens == 0 then
			return
		end
		table.insert(tests, { name = tokens[1], command = table.move(tokens, 2, #tokens, 1, {}) })
	end)
	return tests
end

--- The directories that the `subdirs()` calls of `text` name, in file order.
local function parse_subdirs(text)
	local dirs = {}
	each_call(text, "subdirs", function(tokens)
		for _, token in ipairs(tokens) do
			table.insert(dirs, token)
		end
	end)
	return dirs
end

return {
	parse_ctest_testfile = parse_ctest_testfile,
	parse_subdirs = parse_subdirs,
}
