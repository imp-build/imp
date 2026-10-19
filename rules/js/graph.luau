-- Graph tasks for dependency installation, TypeScript compilation, and run.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local run = require("@imp/rules/workflows/run")
local node = require("@imp/rules/js/node")
local pnpm = require("@imp/rules/js/pnpm")
local output = core.output
local DEFAULT_SOURCES = table.freeze({ "*.js", "*.jsx", "*.ts", "*.tsx" })
local hooks = {}

local function workspace_path(base, src)
	assert(type(base) == "string" and type(src) == "string", "js paths must be strings")
	local parts = {}
	for part in string.gmatch(base .. "/" .. src, "[^/]+") do
		assert(part ~= "..", `js paths must stay within the workspace: {src}`)
		if part ~= "." then table.insert(parts, part) end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end

--- Register an extension that adds application facets at declaration time.
local function register_js_app_hook(hook)
	assert(type(hook) == "function", "register_js_app_hook expects a function")
	if not table.find(hooks, hook) then table.insert(hooks, hook) end
end
local function graph_tool(value, module)
	if type(value) == "userdata" then return value end
	assert(value == nil or type(value) == "string", "toolchain version must be a string or tool handle")
	return module.graph_toolchain(value).tool
end
local function app_spec(options)
	local root = workspace_path(options.base or core.package_path(), options.src or ".")
	local patterns = options.sources or DEFAULT_SOURCES
	assert(type(patterns) == "table" and #patterns > 0, "js_app sources requires source glob patterns")
	local include = { "package.json", "pnpm-lock.yaml", "tsconfig.json" }
	for _, pattern in ipairs(patterns) do
		assert(type(pattern) == "string" and pattern ~= "", "js_app sources expects non-empty glob patterns")
		table.insert(include, pattern)
	end
	return {
		root = root, entry = options.entry or "index.js", sources = core.files({ root = root, include = include }),
		node = graph_tool(options.node_version, node), pnpm = graph_tool(options.pnpm_version, pnpm),
	}
end
local function app_install(spec)
	return core.task({
		inputs = {
			sources = core.files({ root = spec.root, include = { "package.json", "pnpm-lock.yaml" } }),
			node = spec.node, pnpm = spec.pnpm, sh = core.native_tool("sh"),
		},
		outputs = { node_modules = output.artifact() },
		run = function(exec, input)
			local result = exec.action({
				display = `js install {spec.root}`,
				argv = { "sh", "-c", 'root=$1; pnpm=$2; cd "$root" && "$pnpm" install --frozen-lockfile',
					"js-install", spec.root, pnpm.pnpm_bin(exec, input.pnpm) },
				inputs = { input.sources },
				outputs = { node_modules = output.directory(`{spec.root}/node_modules`) },
			})
			return { node_modules = result.outputs.node_modules }
		end,
	})
end
local function app_typecheck(spec, install)
	return core.task({
		inputs = { sources = spec.sources, node_modules = install.outputs.node_modules, node = spec.node,
			sh = core.native_tool("sh"), dirname = core.native_tool("dirname"), sed = core.native_tool("sed"), uname = core.native_tool("uname") },
		outputs = { ok = output.value(), dist = output.artifact() },
		run = function(exec, input)
			local result = exec.action({
				display = `js typecheck {spec.root}`,
				argv = { "sh", "-c", 'cd "$1" && { test -x node_modules/.bin/tsc || { echo "ts_app requires a typescript dependency" >&2; exit 1; }; } && node_modules/.bin/tsc -p tsconfig.json', "js-typecheck", spec.root },
				inputs = { input.sources, input.node_modules },
				outputs = { dist = output.directory(`{spec.root}/dist`) },
			})
			return { ok = true, dist = result.outputs.dist }
		end,
	})
end
local function app_run(spec, install, dist)
	local inputs = { sources = spec.sources, node_modules = install.outputs.node_modules,
		node = spec.node, sh = core.native_tool("sh"), dist = dist }
	return core.program({
		inputs = inputs,
		describe = function(exec, input)
			local digests = { exec.digest(input.sources), exec.digest(input.node_modules) }
			if input.dist then table.insert(digests, exec.digest(input.dist)) end
			local entry = if dist then `dist/{spec.entry}` else spec.entry
			return {
				argv = { "sh", "-c", 'root=$1; node=$2; entry=$3; shift 3; cd "$IMP_SANDBOX_ROOT/$root" && exec "$node" "$entry" "$@"',
					"js-run", spec.root, node.node_bin(exec, input.node), entry },
				inputs = digests, tools = { input.sh, input.node }, display = `js run {spec.root}`,
			}
		end,
	})
end
local function app_value(spec, install, compiled)
	local value = { sources = spec.sources, root = spec.root,
		[build.BUILD] = if compiled then compiled.outputs.ok else install.outputs.node_modules,
		[run.RUN] = app_run(spec, install, if compiled then compiled.outputs.dist else nil) }
	for _, hook in ipairs(hooks) do
		for key, field in pairs(hook(table.freeze(table.clone(value)))) do value[key] = field end
	end
	return table.freeze(value)
end

--- Declare a JavaScript application. Options: src, base, sources, entry,
--- node_version, and pnpm_version. Return sources, root, BUILD, and RUN.
local function js_app(options)
	local spec = app_spec(options or {})
	return app_value(spec, app_install(spec), nil)
end

--- Declare a TypeScript application with the js_app options. The project
--- must declare TypeScript and tsconfig.json with outDir set to "dist".
--- The entry is relative to the compiled dist directory.
local function ts_app(options)
	local spec = app_spec(options or {})
	local install = app_install(spec)
	return app_value(spec, install, app_typecheck(spec, install))
end
return { js_app = js_app, ts_app = ts_app, register_js_app_hook = register_js_app_hook,
	JS_APP_SOURCE_INCLUDES = DEFAULT_SOURCES, workspace_path = workspace_path }
