local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local lint = require("@imp/rules/workflows/lint")
local test = require("@imp/rules/workflows/test")
local run = require("@imp/rules/workflows/run")
local treesitter = require("@imp/rules/treesitter")
local zola = require("@imp/rules/zola")

-- Load the complete built-in catalog for schema extraction. The workspace
-- imports only the extensions used by its BUILD declarations.
local catalog = {
	"asset",
	"c",
	"c/cmake",
	"c/generate_build",
	"c/gcc",
	"c/mold",
	"c/msvc",
	"c/zig",
	"imp/archive",
	"imp/codegen",
	"imp/generate",
	"imp/lockfile",
	"imp/luau",
	"imp/toolchain",
	"js",
	"js/biome",
	"js/node",
	"js/pnpm",
	"oci",
	"oci/toolchain",
	"odin",
	"odin/odinfmt",
	"odin/vscode",
	"python",
	"python/test",
	"python/ruff/fmt",
	"python/ruff/lint",
	"rust",
	"rust/generate_build",
	"rust/kache",
	"rust/toolchain",
	"treesitter",
	"workflows/vs",
	"zola",
}
for _, address in ipairs(catalog) do
	require("@imp/rules/" .. address)
end
local python = core.native_tool("python3")
local shell = core.native_tool("sh")
local mkdir = core.native_tool("mkdir")
local cp = core.native_tool("cp")
local reference_sources = core.files({
	root = ".",
	include = {
		"rules/**/*.luau",
		"rules/**/DOC.md",
		"docs/core_api.luau",
		"docs/luau_api_extract.py",
		"docs/build_reference.py",
	},
	exclude = {
		"**/*.test.luau",
		"**/BUILD.luau",
		"**/testdata/**",
		"**/example/**",
		"**/target/**",
		"rules/workflows/no_handler_check.luau",
	},
})
local schemas = core.json_encode(core.configuration_schemas())
local reference = core.task({
	display = "extract Luau API reference",
	inputs = {
		sources = reference_sources,
		python = python,
		extractor = treesitter.luau_reference[package.PACKAGE],
		grammar = treesitter.luau_grammar.archive,
	},
	outputs = { dir = core.output.artifact() },
	run = function(exec, input)
		return {
			dir = exec.action({
				argv = {
					"python3",
					"docs/build_reference.py",
					"--extractor",
					exec.path(input.extractor),
					"--grammar",
					exec.path(input.grammar),
					"--schemas",
					schemas,
					"--output",
					"reference",
				},
				inputs = { input.sources, input.extractor, input.grammar },
				outputs = { dir = core.output.directory("reference") },
			}).outputs.dir,
		}
	end,
})
local site_sources = core.files({
	root = ".",
	include = { "docs/config.toml", "docs/EDITORIAL.md", "docs/content/**", "docs/templates/**", "docs/static/**" },
})
local site = core.task({
	display = "build docs site with zola",
	inputs = {
		sources = site_sources,
		reference = reference.outputs.dir,
		zola = zola.graph_toolchain().tool,
		sh = shell,
		mkdir = mkdir,
		cp = cp,
	},
	outputs = { dir = core.output.artifact() },
	run = function(exec, input)
		local script =
			'set -e; ref=$1; zola=$2; mkdir -p site/content/reference site/templates site/static; cp docs/config.toml site/config.toml; cp docs/EDITORIAL.md site/static/EDITORIAL.md; cp -r docs/content/. site/content/; cp -r docs/templates/. site/templates/; cp -r docs/static/. site/static/; cp -r "$ref/luau-api" "$ref/user-api" site/content/reference/; "$zola" --root site build --output-dir site/public'
		return {
			dir = exec.action({
				argv = { "sh", "-c", script, "docs-site", exec.path(input.reference), zola.zola_bin(exec, input.zola) },
				inputs = { input.sources, input.reference },
				outputs = { dir = core.output.directory("site") },
			}).outputs.dir,
		}
	end,
})
local quality_sources = core.files({
	root = ".",
	include = {
		"README.md",
		"docs/**/*.py",
		"docs/core_api.luau",
		"rules/**/*.luau",
		"docs/EDITORIAL.md",
		"docs/content/**",
		"docs/templates/**",
		"docs/config.toml",
		"rules/**/DOC.md",
	},
	exclude = { "**/__pycache__/**" },
})
local quality = core.task({
	display = "check documentation quality",
	inputs = { sources = quality_sources, reference = reference.outputs.dir, site = site.outputs.dir, python = python },
	outputs = { result = core.output.value() },
	run = function(exec, input)
		local result = exec.action({
			argv = {
				"python3",
				"docs/quality_check.py",
				"--site",
				exec.path(input.site),
				"--api-reference",
				exec.path(input.reference),
			},
			inputs = { input.sources, input.site, input.reference },
			allow_failure = true,
		})
		return { result = { ok = result.exit_code == 0, output = result.stdout .. result.stderr } }
	end,
})
local tests = core.task({
	display = "test documentation tools",
	inputs = {
		sources = quality_sources,
		python = python,
		extractor = treesitter.luau_reference[package.PACKAGE],
		grammar = treesitter.luau_grammar.archive,
		samples = reference_sources,
	},
	outputs = { units = core.output.value() },
	run = function(exec, input)
		local result = exec.action({
			argv = { "python3", "-m", "unittest", "discover", "-s", "docs", "-p", "*_test.py" },
			env = { IMP_LUAU_EXTRACTOR = exec.path(input.extractor), IMP_LUAU_GRAMMAR = exec.path(input.grammar) },
			inputs = { input.sources, input.extractor, input.grammar, input.samples },
			allow_failure = true,
		})
		return {
			units = {
				{ name = "docs Python tools", ok = result.exit_code == 0, output = result.stdout .. result.stderr },
			},
		}
	end,
})
-- A nested Imp build resolves native acquisition tools through the program's
-- declared PATH, even when a downloaded artifact is already cached.
local preview_inputs = {
	script = core.files({ paths = { "docs/serve.py" } }),
	python = python,
	imp = core.self_tool(),
	zola = zola.graph_toolchain().tool,
}
local preview_native = { "sh", "mkdir", "cp", "dirname", "curl", "wc", "tar", "gzip", "xz", "chmod" }
table.insert(preview_native, require("@imp/rules/imp/lockfile").sha_tool_name(core.platform_info()))
if core.platform_info().os == "windows" then
	table.insert(preview_native, "unzip")
	table.insert(preview_native, "mv")
end
for _, name in ipairs(preview_native) do
	preview_inputs[name] = core.native_tool(name)
end
local preview = core.program({
	inputs = preview_inputs,
	describe = function(exec, input)
		local tools = {}
		for name, handle in pairs(input) do
			if name ~= "script" then
				table.insert(tools, handle)
			end
		end
		return {
			argv = {
				"sh",
				"-c",
				'zola=$1; shift; exec python3 "$IMP_SANDBOX_ROOT/docs/serve.py" --imp imp --zola "$zola" "$@"',
				"docs-preview",
				zola.zola_bin(exec, input.zola),
			},
			inputs = { exec.digest(input.script) },
			tools = tools,
			display = "watch and serve docs",
		}
	end,
})

return {
	api_reference = { dir = reference.outputs.dir, [build.BUILD] = reference.outputs.dir },
	site = { [build.BUILD] = site.outputs.dir, [package.PACKAGE] = site.outputs.dir },
	quality = { [lint.LINT] = quality.outputs.result },
	quality_tests = { [test.TEST] = tests.outputs.units },
	site_serve = { [run.RUN] = preview },
}
