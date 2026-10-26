-- Tests of `@imp/rules/c/msvc`.
--
-- The JavaScript module has no tests of the MSVC provider. The JavaScript
-- `nasmHostBin` cases are not ported: the Luau module does not provide it
-- (see the header comment of the module).
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local msvc = require("@imp/rules/c/msvc")

local TESTDATA = "@imp/rules/c/msvc/testdata"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
-- The SHA-256 of NASM 3.02 in the shipped lockfile.
local SHIPPED_SHA = "161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7"
local DISCOVERED = table.concat({
	"C:/Program Files/Microsoft Visual Studio/2022/Community",
	"14.44.35207",
	"C:/Program Files (x86)/Windows Kits/10",
	"10.0.26100.0",
}, "\r\n") .. "\r\n"
local HOST = {
	vs_root = "C:/VS",
	msc_version = "14.44.35207",
	sdk_root = "C:/Kits/10",
	sdk_version = "10.0.26100.0",
}
local VC_BIN = "C:/VS/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64"
local SDK_BIN = "C:/Kits/10/bin/10.0.26100.0/x64"

local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function has(list, value)
	for _, item in ipairs(list) do
		if item == value then
			return true
		end
	end
	return false
end

local function same(actual, expected)
	assert(#actual == #expected, `expected {#expected} values, got {#actual}: {table.concat(actual, " ")}`)
	for index, value in ipairs(expected) do
		assert(actual[index] == value, `value {index}: expected {value}, got {actual[index]}`)
	end
end

local function with_msvc_host(plat, fn)
	return core.test.with_fake_toolchain_host(plat, function(host)
		msvc.reset_for_test()
		return fn(host)
	end)
end

--- Install NASM `version` with faked actions, and return its install
--- directory.
local function install_nasm(version)
	return core.test.resolve(core.task({
		inputs = { tool = msvc.nasm_graph_tool(version) },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = exec.tool_dir(inputs.tool) }
		end,
	}).outputs.value)
end

--- Resolve `fn(exec, inputs)` in a task with the inputs of `provider`.
local function with_provider_inputs(provider, fn)
	return core.test.resolve(core.task({
		inputs = provider.task_inputs(),
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = fn(exec, inputs) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("NASM toolchain", {
		core.test.case("the artifact name and URL follow the nasm.us release layout", function()
			assert(msvc.nasm_artifact_name("3.02", WINDOWS) == "nasm-3.02-win64.zip")
			assert(
				msvc.nasm_download_url("3.02", WINDOWS)
					== "https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip"
			)
			local text = error_text(msvc.nasm_artifact_name, "3.02", LINUX)
			assert(contains(text, "unsupported NASM platform: linux/x86_64 (windows/x86_64 only)"), text)
		end),

		core.test.case("the module declares the pinned default on Windows only", function()
			if core.platform_info().os == "windows" then
				assert(msvc.NASM.default_version() == "3.02")
			else
				assert(msvc.NASM.default_version() == nil)
			end
		end),

		core.test.case("graph construction runs no action", function()
			with_msvc_host(WINDOWS, function(host)
				msvc.nasm_toolchain("3.02", { default = true })
				msvc.nasm_graph_tool("3.02")
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("installs NASM into a version-keyed named cache", function()
			with_msvc_host(WINDOWS, function(host)
				msvc.nasm_toolchain("3.02", { default = true })
				assert(install_nasm() == "/cache/msvc-nasm/3.02/windows-x86_64")
				local installed = host.runs[2]
				assert(installed.display == "install nasm 3.02 (windows/x86_64)", installed.display)
				same(installed.tools, { "mkdir", "mv", "sh", "unzip" })
				assert(contains(installed.argv[3], 'mv "$2.stage"/*/* "$2"'), installed.argv[3])
			end)
		end),

		core.test.case("the pinned version installs when no version is declared", function()
			with_msvc_host(WINDOWS, function(host)
				assert(install_nasm() == "/cache/msvc-nasm/3.02/windows-x86_64")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),
	}),

	core.test.suite("NASM workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_msvc_host(WINDOWS, function(host)
				msvc.nasm_toolchain("3.02", { default = true })
				install_nasm("3.02")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_msvc_host(WINDOWS, function(host)
				msvc.nasm_toolchain("2.16.03", { default = true, lockfile = `{TESTDATA}/custom.json` })
				install_nasm("2.16.03")
				assert(has(host.runs[1].argv, "beef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_msvc_host(WINDOWS, function()
				local address = `{TESTDATA}/missing.json`
				msvc.nasm_toolchain("2.16.03", { default = true, lockfile = address })
				local text = error_text(install_nasm, "2.16.03")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_msvc_host(WINDOWS, function()
				local text = error_text(msvc.nasm_toolchain, "2.16.03", { lockfile = "locks/nasm.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			with_msvc_host(WINDOWS, function(host)
				host.set_run_stdout("lock nasm 2.16.03 windows/x86_64", string.rep("ab", 32) .. "  artifact\n  42\n")
				local declared =
					msvc.nasm_toolchain("2.16.03", { default = true, lockfile = "@workspace/locks/nasm.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/nasm.lock", result.path)
				local written = false
				for _, recorded in ipairs(host.runs) do
					if recorded.display == "write locks/nasm.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/nasm.lock")
			end)
		end),
	}),

	core.test.suite("MSVC host toolchain", {
		core.test.case("parse_msvc_host reads the four discovery lines", function()
			local host = msvc.parse_msvc_host(DISCOVERED)
			assert(host.vs_root == "C:/Program Files/Microsoft Visual Studio/2022/Community", host.vs_root)
			assert(host.msc_version == "14.44.35207")
			assert(host.sdk_root == "C:/Program Files (x86)/Windows Kits/10")
			assert(host.sdk_version == "10.0.26100.0", host.sdk_version)
			local text = error_text(msvc.parse_msvc_host, "C:/VS\n14.44\n")
			assert(contains(text, "failed to discover a host MSVC toolchain"), text)
		end),

		core.test.case("the discovery task runs vswhere one time without a cache", function()
			with_msvc_host(WINDOWS, function(host)
				host.set_run_stdout("discover MSVC host toolchain", DISCOVERED)
				-- Two providers and two consumer tasks share one discovery task.
				local first, second = msvc.msvc_toolchain(), msvc.msvc_toolchain()
				local state = with_provider_inputs(first, first.resolve_state)
				local other = with_provider_inputs(second, second.resolve_state)
				assert(state.msc_version == "14.44.35207")
				assert(other.msc_version == "14.44.35207")
				local discoveries = 0
				for _, run in ipairs(host.runs) do
					if run.display == "discover MSVC host toolchain" then
						discoveries += 1
						assert(run.cache == false)
						assert(contains(run.argv[3], "-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64"))
						assert(
							has(run.argv, "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe")
						)
					end
				end
				assert(discoveries == 1, tostring(discoveries))
			end)
		end),

		core.test.case("task inputs add NASM on Windows only", function()
			with_msvc_host(WINDOWS, function()
				local inputs = msvc.msvc_toolchain().task_inputs()
				assert(type(inputs.msvc_host) == "userdata")
				assert(type(inputs.nasm) == "userdata")
			end)
			with_msvc_host(LINUX, function(host)
				local inputs = msvc.msvc_toolchain().task_inputs()
				assert(type(inputs.msvc_host) == "userdata")
				assert(inputs.nasm == nil)
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("msvc_env puts the host bin directories on PATH and sets INCLUDE and LIB", function()
			local env = msvc.msvc_env(HOST)
			assert(env.PATH == `{VC_BIN};{SDK_BIN}`, env.PATH)
			assert(
				env.INCLUDE
					== "C:/VS/VC/Tools/MSVC/14.44.35207/include;C:/Kits/10/Include/10.0.26100.0/ucrt;C:/Kits/10/Include/10.0.26100.0/um;C:/Kits/10/Include/10.0.26100.0/shared",
				env.INCLUDE
			)
			assert(
				env.LIB
					== "C:/VS/VC/Tools/MSVC/14.44.35207/lib/x64;C:/Kits/10/Lib/10.0.26100.0/ucrt/x64;C:/Kits/10/Lib/10.0.26100.0/um/x64",
				env.LIB
			)
			assert(env.MSYS2_ARG_CONV_EXCL == "*")
		end),

		core.test.case("cmake_configure gives the host compiler, SDK, and NASM paths", function()
			with_msvc_host(WINDOWS, function(host)
				host.set_run_stdout("discover MSVC host toolchain", "C:/VS\n14.44.35207\nC:/Kits/10\n10.0.26100.0\n")
				local provider = msvc.msvc_toolchain()
				local configured = with_provider_inputs(provider, provider.cmake_configure)
				same(configured.compiler_args, {
					`-DCMAKE_C_COMPILER={VC_BIN}/cl.exe`,
					`-DCMAKE_CXX_COMPILER={VC_BIN}/cl.exe`,
					`-DCMAKE_RC_COMPILER={SDK_BIN}/rc.exe`,
					`-DCMAKE_MT={SDK_BIN}/mt.exe`,
					"-DCMAKE_ASM_NASM_COMPILER=/cache/msvc-nasm/3.02/windows-x86_64/nasm.exe",
					"-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON",
				})
				assert(configured.env.PATH == `{VC_BIN};{SDK_BIN}`)
				assert(provider.edge_env(HOST).LIB ~= nil)
			end)
		end),

		core.test.case("cmake_configure fails clearly off Windows", function()
			with_msvc_host(LINUX, function(host)
				host.set_run_stdout("discover MSVC host toolchain", DISCOVERED)
				local provider = msvc.msvc_toolchain()
				local ok, err = pcall(with_provider_inputs, provider, provider.cmake_configure)
				assert(not ok)
				assert(contains(tostring(err), "CMake configure runs on a Windows host only"), tostring(err))
			end)
		end),

		core.test.case("commands builds cl.exe and lib.exe tokens with Windows response-file quoting", function()
			local provider = msvc.msvc_toolchain()
			local commands = provider.commands(nil, { msvc_host = HOST })
			assert(commands.env.PATH == `{VC_BIN};{SDK_BIN}`)
			assert(commands.rsp_quote("obj/a.obj") == "obj/a.obj")
			assert(commands.rsp_quote("a b.obj") == '"a b.obj"')
			same(
				commands.compile_command({
					source = "src/a.cc",
					obj_path = "out/a.obj",
					is_cxx = true,
					include_dirs = { "inc" },
					opt = "release",
					copts = { "/W4" },
				}),
				{
					"cl.exe",
					"/nologo",
					"/c",
					"/TP",
					"/O2",
					"/DNDEBUG",
					"'/Iinc'",
					"'/W4'",
					"'/Foout/a.obj'",
					"'src/a.cc'",
				}
			)
			same(
				commands.compile_command({ source = "a.c", obj_path = "a.obj", is_cxx = false, opt = "debug" }),
				{ "cl.exe", "/nologo", "/c", "/TC", "/Od", "/Zi", "'/Foa.obj'", "'a.c'" }
			)
			same(
				commands.archive_command({ out_path = "a.lib", rsp_path = "a.rsp" }),
				{ "lib.exe", "/nologo", "'/OUT:a.lib'", "@'a.rsp'" }
			)
			same(
				commands.link_command({ out_path = "m.dll", is_shared = true, rsp_path = "m.rsp" }),
				{ "cl.exe", "/nologo", "/LD", "'/Fem.dll'", "@'m.rsp'" }
			)
		end),

		core.test.case("the provider resolves the bare CMake replay tool names", function()
			local provider = msvc.msvc_toolchain()
			assert(msvc.is_msvc_toolchain(provider))
			assert(table.isfrozen(provider))
			for _, name in ipairs({ "cl.exe", "link.exe", "lib.exe", "rc", "mt.exe", "nasm" }) do
				assert(provider.resolves_tool_name(name), name)
			end
			assert(not provider.resolves_tool_name("clang"))
		end),
	}),
}
