local core = require("@imp/core")
local publish = require("@imp/rules/workflows/publish")

return {
	core.test.suite("graph_publish_goal", {
		core.test.case("reports each selected root", function()
			local report = publish.graph_publish_goal({
				{ address = "//images:app", result = nil },
				{ address = "//images:worker", result = { pushed = true } },
			})
			assert(report == "Published 2 targets:\n  //images:app\n  //images:worker", report)
		end),

		core.test.case("no roots give no report", function()
			assert(publish.graph_publish_goal({}) == nil)
		end),
	}),
}
