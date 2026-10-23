local core = require("@imp/core")
local odin = require("@imp/rules/odin/toolchain")
local fmt = require("@imp/rules/odin/odinfmt/toolchain")
return {
	core.test.case("odinfmt release identity includes one executable suffix", function()
		assert(fmt.command_name({ os = "windows", arch = "x86_64" }) == "odinfmt-x86_64-pc-windows-msvc.exe")
		assert(fmt.artifact_name("dev-2026-03", { os = "linux", arch = "aarch64" }) == "ols-arm64-unknown-linux-gnu.zip")
	end),
	core.test.case("implicit formatter default tracks Odin and explicit default wins", function()
		odin.odin_toolchain("dev-2026-03", { default = true })
		assert(fmt.default_version() == "dev-2026-03")
		odin.odin_toolchain("dev-2026-08", { default = true })
		assert(fmt.default_version() == "dev-2026-08")
		fmt.odinfmt_toolchain("dev-2026-03", { default = true })
		assert(fmt.default_version() == "dev-2026-03")
	end),
	core.test.case("formatter acquisition uses the verified OLS zip and cache", function()
		core.test.with_fake_toolchain_host(function(host)
			local tool = fmt.graph_toolchain("dev-2026-03").tool
			local path = core.test.resolve(core.task({ inputs = { tool = tool }, outputs = { path = core.output.value() }, run = function(exec, input)
				return { path = fmt.bin(exec, input.tool) }
			end }).outputs.path)
			assert(string.find(path, "/cache/odinfmt-toolchains/dev-2026-03/linux-x86_64/odinfmt-x86_64-unknown-linux-gnu", 1, true), path)
			assert(#host.runs == 2)
		end)
	end),
}
