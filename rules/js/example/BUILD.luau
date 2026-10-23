local js = require("@imp/rules/js")
require("@imp/rules/js/biome")
require("@imp/rules/js/biome/lint")

return {
	hello = js.js_sources(),
	hello_src = js.js_sources({ src = "src" }),
	app = js.js_app({
		src = "app",
		entry = "src/index.js",
		sources = { "src/**/*.js" },
	}),
	app_ts = js.ts_app({
		src = "app_ts",
		entry = "index.js",
		sources = { "src/**/*.ts" },
	}),
}
