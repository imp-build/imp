local core = require("@imp/core")
local native = require("@imp/rules/imp/native-tool")
local output = core.output

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

--- A task that runs one shell command with `tool` in its inputs and returns
--- the action status.
local function shell_task(tool, script, env)
	return core.task({
		inputs = { tool = tool },
		outputs = { status = output.value() },
		run = function(exec)
			local result = exec.action({
				argv = { "sh", "-c", ": > marker; " .. script },
				display = "native tool probe",
				env = env,
				allow_failure = true,
				outputs = { marker = output.file("marker") },
			})
			return { status = { code = result.exit_code, stdout = result.stdout } }
		end,
	})
end

return {
	core.test.suite("native_tool", {
		core.test.case("returns a graph tool handle, not a table", function()
			local handle = native.native_tool("sh")
			assert(type(handle) == "userdata", type(handle))
		end),

		core.test.case("rejects a name that is empty or not a string", function()
			local expected = "native_tool(name) requires a non-empty executable name"
			for _, name in { "", 42 } do
				local text = error_text(native.native_tool, name)
				assert(contains(text, expected), text)
			end
			local text = error_text(native.native_tool, nil)
			assert(contains(text, expected), text)
		end),

		core.test.case("the tool is on PATH even with an empty base PATH", function()
			local status = core.test.resolve(
				shell_task(native.native_tool("cat"), "printf hi | cat", { PATH = "" }).outputs.status
			)
			assert(status.code == 0, tostring(status.code))
			assert(contains(status.stdout, "hi"), status.stdout)
		end),

		core.test.case("an action fails for a binary that is not on PATH", function()
			local text = error_text(
				core.test.resolve,
				shell_task(native.native_tool("__imp_no_such_binary_xyz"), "true").outputs.status
			)
			assert(contains(text, "__imp_no_such_binary_xyz"), text)
			assert(contains(text, "PATH"), text)
		end),
	}),
}
