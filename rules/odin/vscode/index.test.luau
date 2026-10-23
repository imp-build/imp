local core = require("@imp/core")
require("@imp/rules/odin/vscode")
require("@imp/rules/odin/odinfmt")
local odin = require("@imp/rules/odin")
local vs = require("@imp/rules/workflows/vs")
local fmt = require("@imp/rules/workflows/fmt")
local function package(path, options)
	options = options or {}
	options.base, options.path = ".", path
	return odin.odin_package(options)
end
local function resolve(handle)
	return core.test.resolve(core.task({ inputs = { value = handle }, outputs = { value = core.output.value() },
		run = function(_, input) return { value = input.value } end }).outputs.value)
end
return {
	core.test.case("import adds a VS Code handle and preserves formatter hooks", function()
		local value = package("rules/odin/example")
		assert(type(value[vs.VSCODE]) == "userdata" and type(value[fmt.FMT]) == "userdata")
	end),
	core.test.case("Windows bundle metadata uses the published executable name", function()
		core.test.with_fake_toolchain_host({ os = "windows", arch = "x86_64" }, function(host)
			host.set_run_stdout("tree-sitter analyze Odin sources", [=[{"files":{"rules/odin/example/main.odin":{"imports":[],"hasMainEntrypoint":true}}}]=])
			local shared = core.files({ root = "rules/odin/example", include = { "main.odin" } })
			local value = package("rules/odin/example", { deps = { { transitive_shared_libs = { shared } } } })
			local info = resolve(value[vs.VSCODE])
			assert(info.has_main and info.executable_path == "output.exe")
		end)
	end),

	core.test.case("metadata scans sources without building the selected package", function()
		core.test.with_fake_toolchain_host(function(host)
			host.set_run_stdout("tree-sitter analyze Odin sources", [=[{"files":{"rules/odin/example/main.odin":{"imports":[],"hasMainEntrypoint":true},"rules/odin/example/split/split.odin":{"imports":[],"hasMainEntrypoint":false},"rules/odin/example/split/split_test.odin":{"imports":[],"hasMainEntrypoint":true}}}]=])
			local main = resolve(package("rules/odin/example")[vs.VSCODE])
			assert(main.has_main and not main.is_test and main.executable_path == nil)
			local library = resolve(package("rules/odin/example/split")[vs.VSCODE])
			assert(not library.has_main)
			local tested = odin.odin_test_package({ base = ".", path = "rules/odin/example/split" })
			assert(resolve(tested[vs.VSCODE]).is_test)
			for _, action in ipairs(host.runs) do
				assert(not string.find(action.display or "", "odin build rules/odin/example", 1, true))
			end
		end)
	end),
}
