local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local js = require("@imp/rules/js")
return {
	core.test.case("js_sources exports frozen sources and a build facet", function()
		local value = js.js_sources({ base = "rules/js", src = "example" })
		assert(value.root == "rules/js/example")
		assert(type(value.sources) == "userdata")
		assert(type(value[build.BUILD]) == "userdata")
		core.test.resolve(value[build.BUILD])
		assert(table.isfrozen(value))
	end),
	core.test.case("js_sources rejects workspace escapes", function()
		local ok, err = pcall(js.js_sources, { base = "rules/js", src = "../outside" })
		assert(not ok and string.find(tostring(err), "must stay within the workspace", 1, true))
	end),
	core.test.case("source hooks run once and receive frozen declarations", function()
		local count = 0
		local hook = function(value)
			assert(table.isfrozen(value))
			count += 1
			return { marker = value.root }
		end
		js.register_js_sources_hook(hook)
		js.register_js_sources_hook(hook)
		assert(js.js_sources({ base = "rules/js" }).marker == "rules/js")
		assert(count == 1)
	end),
}
