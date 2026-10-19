local core = require("@imp/core")
local js = require("@imp/rules/js")
local node = require("@imp/rules/js/node")
local pnpm = require("@imp/rules/js/pnpm")
local build = require("@imp/rules/workflows/build")
local run = require("@imp/rules/workflows/run")
local function fake(fn)
	core.test.with_fake_toolchain_host(function(host)
		node.reset_for_test()
		pnpm.reset_for_test()
		node.node_toolchain("26.8.2", { default = true })
		pnpm.pnpm_toolchain("12.4.1", { default = true })
		fn(host)
	end)
end
local function app_options(ts)
	return { base = "rules/js/example", src = if ts then "app_ts" else "app",
		entry = if ts then "index.js" else "src/index.js", sources = { "src/**/*" } }
end
return {
	core.test.case("applications declare build and program facets", function()
		fake(function(host)
			for _, value in ipairs({ js.js_app(app_options(false)), js.ts_app(app_options(true)) }) do
				assert(table.isfrozen(value))
				assert(type(value[build.BUILD]) == "userdata")
				assert(type(value[run.RUN]) == "userdata")
			end
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("install stages only package metadata", function()
		fake(function(host)
			local app = js.js_app(app_options(false))
			core.test.resolve(app[build.BUILD])
			local install = host.runs[#host.runs]
			assert(install.display == "js install rules/js/example/app")
			assert(string.find(install.argv[3], "install --frozen-lockfile", 1, true))
			assert(install.input_count == 1)
		end)
	end),
	core.test.case("TypeScript compilation consumes installation and captures dist", function()
		fake(function(host)
			assert(core.test.resolve(js.ts_app(app_options(true))[build.BUILD]))
			local compile = host.runs[#host.runs]
			assert(compile.display == "js typecheck rules/js/example/app_ts")
			assert(string.find(compile.argv[3], "node_modules/.bin/tsc -p tsconfig.json", 1, true))
		end)
	end),
	core.test.case("application source patterns and workspace paths are checked", function()
		for _, options in ipairs({ { sources = {} }, { sources = { "" } }, { src = "../outside" } }) do
			assert(not pcall(js.js_app, options))
		end
	end),
	core.test.case("application extension hooks are ordered and deduplicated", function()
		local seen = {}
		local first = function(value)
			assert(table.isfrozen(value))
			table.insert(seen, "first")
			return { first = true }
		end
		js.register_js_app_hook(first)
		js.register_js_app_hook(first)
		js.register_js_app_hook(function(value)
			assert(value.first)
			table.insert(seen, "second")
			return {}
		end)
		fake(function() js.js_app(app_options(false)) end)
		assert(table.concat(seen, ",") == "first,second")
	end),
}
