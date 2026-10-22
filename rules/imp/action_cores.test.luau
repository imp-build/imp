local core = require("@imp/core")

local function action(cores)
	return core.task({
		run = function(exec)
			exec.action({ argv = { "unused" }, cores = cores })
		end,
	})
end

return {
	core.test.suite("action cores", {
		core.test.case("records requested cores and defaults to one", function()
			core.test.with_fake_run(function(host)
				core.test.resolve(action(4))
				core.test.resolve(action(nil))
				core.test.resolve(action(4294967295))
				assert(host.runs[1].cores == 4)
				assert(host.runs[2].cores == 1)
				assert(host.runs[3].cores == 4294967295)
			end)
		end),
		core.test.case("rejects invalid cores before recording an action", function()
			core.test.with_fake_run(function(host)
				for _, value in { 0, -1, 1.5, math.huge, -math.huge, 0 / 0, 4294967296, "2", true, {} } do
					local ok, problem = pcall(core.test.resolve, action(value))
					assert(not ok, "accepted invalid cores")
					assert(string.find(tostring(problem), "exec.action().cores must be an integer of 1 or more within the u32 range", 1, true), tostring(problem))
				end
				assert(#host.runs == 0)
			end)
		end),
	}),
}
