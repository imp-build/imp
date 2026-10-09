local core = require("@imp/core")

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

-- The JavaScript module also tests structural task dedupe and nested
-- invocation scopes. Each Luau `core.task` call makes a new handle and Luau
-- has no invocation scope API, so those cases have no Luau form here.
return {
	core.test.suite("graph handles", {
		core.test.case("core.test.resolve rejects a value that is not a graph handle", function()
			local text = error_text(core.test.resolve, { nope = true })
			assert(contains(text, "error converting Lua table to userdata"), text)
		end),

		core.test.case("core.test.resolve rejects a handle that is not a task", function()
			local files = core.files({ root = "rules/imp", include = { "*.luau" } })
			local text = error_text(core.test.resolve, files)
			assert(contains(text, "requires a task or task output handle, got files"), text)
		end),

		core.test.case("files() rejects an empty include list", function()
			local text = error_text(core.files, { root = "rules/imp", include = {} })
			assert(contains(text, "files({ include }) requires glob patterns"), text)
		end),
	}),
}
