local core = require("@imp/core")
local generate_build = require("@imp/rules/workflows/generate_build")

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

--- Declare `namespace` with a `build_generate` field, and register a BUILD
--- generator for it that gives no files. Return a function that tells if
--- the generator ran.
local function register(namespace)
	local called = false
	core.define_config_schema(namespace, {
		build_generate = core.field.bool({ default = false }),
	})
	core.register_build_generator({
		namespace = namespace,
		generate = function()
			called = true
			return {}
		end,
	})
	return function()
		return called
	end
end

--- Run the goal with `--check`, so that it never writes to the workspace,
--- and return the report.
local function check()
	return core.test.with_fake_goal_flags({ check = true }, function()
		return generate_build.generate_build_goal({})
	end)
end

return {
	core.test.suite("generate_build_goal", {
		core.test.case("a generator is skipped when its namespace has no build_generate value", function()
			local called = register("generate-build-test-unset")
			check()
			assert(not called())
		end),

		core.test.case("a generator is skipped when build_generate is false", function()
			local called = register("generate-build-test-false")
			core.configure("generate-build-test-false", { build_generate = false })
			check()
			assert(not called())
		end),

		core.test.case("a generator runs when build_generate is true", function()
			local called = register("generate-build-test-on")
			core.configure("generate-build-test-on", { build_generate = true })
			local report = check()
			assert(called())
			assert(report == "generate-build: 0 file(s) checked, 0 out of date", report)
		end),

		core.test.case("a generator namespace must declare a boolean build_generate field", function()
			local ok, err = pcall(core.register_build_generator, {
				namespace = "generate-build-test-undeclared",
				generate = function()
					return {}
				end,
			})
			assert(not ok)
			assert(contains(tostring(err), "must declare a boolean build_generate field"), tostring(err))
		end),
	}),
}
