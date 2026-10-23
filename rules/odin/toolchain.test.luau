local core = require("@imp/core")
local tools = require("@imp/rules/odin/toolchain")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local function contains(text, part) return string.find(tostring(text), part, 1, true) ~= nil end
return {
	core.test.case("Odin release identities match the platform matrix", function()
		assert(#tools.supported_platforms() == 5)
		assert(tools.artifact_name("dev-2026-03", { os = "linux", arch = "x86_64" }) == "odin-linux-amd64-dev-2026-03.tar.gz")
		assert(tools.artifact_name("dev-2026-03", { os = "windows", arch = "x86_64" }) == "odin-windows-amd64-dev-2026-03.zip")
		assert(not pcall(tools.artifact_name, "dev-2026-03", { os = "windows", arch = "aarch64" }))
	end),
	core.test.case("explicit providers retain version and linker metadata", function()
		local linker = { tool = core.native_tool("mold"), version = "2.42.1" }
		local value = tools.odin_toolchain("dev-2026-03", { linker = linker, mingw_crt = true, lld_on_windows = true })
		assert(table.isfrozen(value) and value.version == "dev-2026-03" and value.linker == linker)
		assert(value.mingw_crt and value.lld_on_windows and type(value[lockfiles.GEN_LOCKFILES]) == "userdata")
		assert(tools.default_version() == "dev-2026-08")
	end),
	core.test.case("Odin acquisition verifies archives and resolves the named-cache executable", function()
		core.test.with_fake_toolchain_host(function(host)
			local provider = tools.graph_toolchain("dev-2026-03")
			local path = core.test.resolve(core.task({ inputs = { tool = provider.tool }, outputs = { path = core.output.value() }, run = function(exec, input)
				return { path = tools.bin(exec, input.tool) }
			end }).outputs.path)
			assert(contains(path, "/cache/odin-toolchains/dev-2026-03/linux-x86_64/odin"), path)
			assert(#host.runs == 2 and contains(host.runs[1].argv[3], "sha256sum"))
			assert(contains(table.concat(host.runs[2].argv, " "), "--strip-components=1"))
		end)
	end),
	core.test.case("malformed and missing custom lockfiles fail at the correct boundary", function()
		assert(not pcall(tools.odin_toolchain, "dev-2026-03", { lockfile = "relative.lock" }))
		core.test.with_fake_toolchain_host(function()
			local provider = tools.odin_toolchain("dev-2026-03", { lockfile = "@workspace/absent-odin.lock" })
			local ok, err = pcall(core.test.resolve, core.task({ inputs = { tool = provider.tool }, run = function() end }))
			assert(not ok and contains(err, "absent-odin.lock") and contains(err, "gen-lockfiles"), tostring(err))
		end)
	end),
}
