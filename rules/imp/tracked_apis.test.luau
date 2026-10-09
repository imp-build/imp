local core = require("@imp/core")

local output = core.output

return {
	core.test.suite("with_fake_run", {
		core.test.case("records an action without running it", function()
			local probe = core.task({
				outputs = { code = output.value(), out = output.artifact() },
				run = function(exec)
					local result = exec.action({
						argv = { "sh", "-c", "exit 3" },
						display = "fake probe",
						outputs = { out = output.file("out.txt") },
					})
					return { code = result.exit_code, out = result.outputs.out }
				end,
			})
			core.test.with_fake_run(function(host)
				local result = core.test.resolve(probe)
				assert(result.code == 0, tostring(result.code))
				assert(#host.runs == 1)
				assert(host.runs[1].argv[3] == "exit 3", tostring(host.runs[1].argv[3]))
				assert(host.runs[1].display == "fake probe")
			end)
		end),
	}),

	core.test.suite("configuration", {
		core.test.case("configure deep-merges values that configuration returns", function()
			core.configure("tracked_apis_test", { mode = "debug", nested = { enabled = true } })
			core.configure("tracked_apis_test", { nested = { level = 2 } })
			local value = core.configuration("tracked_apis_test", {})
			assert(value.mode == "debug", tostring(value.mode))
			assert(value.nested.enabled == true)
			assert(value.nested.level == 2, tostring(value.nested.level))
		end),

		core.test.case("configuration returns the fallback for an unset namespace", function()
			local value = core.configuration("tracked_apis_unset", { fallback = true })
			assert(value.fallback == true)
		end),
	}),
}
