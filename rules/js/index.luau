-- Public JavaScript and TypeScript graph API.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local graph = require("@imp/rules/js/graph")
local hooks = {}

--- Register an extension that adds source facets at declaration time.
local function register_js_sources_hook(hook)
	assert(type(hook) == "function", "register_js_sources_hook expects a function")
	if not table.find(hooks, hook) then table.insert(hooks, hook) end
end

--- Declare shallow sources. Options: src ("."), base (the BUILD package).
--- Return frozen sources, root, and BUILD fields.
local function js_sources(options)
	options = options or {}
	local root = graph.workspace_path(options.base or core.package_path(), options.src or ".")
	local sources = core.files({ root = root, include = { "package.json", "*.js", "*.jsx", "*.ts", "*.tsx", "*.json" } })
	local captured = core.task({
		inputs = { sources = sources },
		run = function(exec, input) exec.digest(input.sources) end,
	})
	local value = { sources = sources, root = root, [build.BUILD] = captured }
	for _, hook in ipairs(hooks) do
		for key, field in pairs(hook(table.freeze(table.clone(value)))) do value[key] = field end
	end
	return table.freeze(value)
end
core.register_build_rule({ rule = "js_sources", module = "@imp/rules/js" })
core.register_build_rule({ rule = "js_app", module = "@imp/rules/js" })
core.register_build_rule({ rule = "ts_app", module = "@imp/rules/js" })
return {
	js_sources = js_sources, js_app = graph.js_app, ts_app = graph.ts_app,
	register_js_sources_hook = register_js_sources_hook, register_js_app_hook = graph.register_js_app_hook,
}
