-- Tests of `@imp/rules/c/zig`.
--
-- The JavaScript tests of `installZigToolchain` and `zigBin` are not ported:
-- the Luau module does not provide these functions (see the header comment
-- of the module). The JavaScript test that reads the mount fields of a
-- resolved tool is not ported, because a Luau test cannot resolve a tool
-- handle. The install and prewarm tests check the named caches instead.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local zig = require("@imp/rules/c/zig")
local shell_quote = require("@imp/rules/c/toolchain").shell_quote

local TESTDATA = "@imp/rules/c/zig/testdata"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
-- The SHA-256 of Zig 0.16.0 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"

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

local function published(host, name, key)
	for _, call in ipairs(host.calls) do
		if call[1] == "named_cache" and call[2] == name and call[3] == key then
			return true
		end
	end
	return false
end

local function with_zig_host(plat, fn)
	return core.test.with_fake_toolchain_host(plat, function(host)
		zig.reset_for_test()
		return fn(host)
	end)
end

--- Install Zig `version` with faked actions, and return the install
--- directory.
local function install(version)
	return core.test.resolve(core.task({
		inputs = { tool = zig.graph_tool(version) },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = exec.tool_dir(inputs.tool) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("Zig toolchain", {
		core.test.case("declares a default Zig toolchain", function()
			with_zig_host(LINUX, function()
				local declared = zig.zig_toolchain("0.13.0", { default = true })
				assert(declared.version == "0.13.0")
				assert(declared.lockfile == "@imp/rules/c/zig/zig.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(zig.cache_key("0.13.0", LINUX) == "v2/0.13.0/linux-x86_64")
				assert(zig.default_version() == "0.13.0")
			end)
		end),

		core.test.case("the module declares the pinned default on a supported platform", function()
			local plat = core.platform_info()
			if (plat.os == "linux" or plat.os == "windows") and (plat.arch == "x86_64" or plat.arch == "aarch64") then
				assert(zig.default_version() == "0.16.0", tostring(zig.default_version()))
			else
				assert(zig.default_version() == nil)
			end
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_zig_host(LINUX, function()
				zig.zig_toolchain("0.13.0")
				local text = error_text(zig.graph_toolchain)
				assert(contains(text, "no Zig toolchain version specified"), text)
				assert(zig.default_graph_toolchain() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and installs a toolchain with sandboxed actions (linux)", function()
			with_zig_host(LINUX, function(host)
				zig.zig_toolchain("0.13.0", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("0.13.0") == "/cache/zig-toolchains/v2/0.13.0/linux-x86_64")
				assert(#host.runs == 2, tostring(#host.runs))

				local download, installed = host.runs[1], host.runs[2]
				assert(has(download.argv, "https://locked.example/zig-linux-x86_64-0.13.0.tar.xz"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])

				assert(installed.argv[1] == "sh")
				assert(contains(installed.argv[5], "zig-linux-x86_64-0.13.0.tar.xz"), installed.argv[5])
				-- A bare sh resolves on Unix without a declared tool.
				same(installed.tools, { "chmod", "mkdir", "tar", "xz" })
				assert(has(installed.argv, "zigar"))
				assert(has(installed.argv, "zigranlib"))
				assert(has(installed.argv, "clang"))
				assert(has(installed.argv, "ar"))
				for index, subcommand in ipairs({ "ar", "ranlib", "cc", "ar" }) do
					local expected = '#!/bin/sh\nexec "${0%/*}/zig" ' .. subcommand .. ' "$@"\n'
					assert(installed.argv[5 + index * 2] == expected, installed.argv[5 + index * 2])
				end
				local script = installed.argv[3]
				assert(contains(script, 'tar -xJf "$1" -C "$2" --strip-components=1'), script)
				-- The fourth wrapper uses positional parameters after $9.
				assert(contains(script, 'printf %s "$9" > "$2/${10}"'), script)
				assert(contains(script, 'chmod +x "$2/${10}"'), script)
				assert(published(host, "zig-toolchains", "v2/0.13.0/linux-x86_64"))
			end)
		end),

		core.test.case("Unix wrappers run without dirname in a real sandbox", function()
			if core.platform_info().os ~= "linux" then
				return
			end
			local wrappers = with_zig_host(LINUX, function(host)
				zig.zig_toolchain("0.13.0", { unverified = true })
				install("0.13.0")
				local argv = host.runs[2].argv
				local captured = {}
				for index = 7, 13, 2 do
					table.insert(captured, { content = argv[index], name = argv[index + 1] })
				end
				return captured
			end)
			local script = {
				'if command -v dirname >/dev/null 2>&1; then exit 1; fi',
				'mkdir "tool chain"',
				'printf %s ' .. shell_quote('#!/bin/sh\nprintf "<%s>\\n" "$@"\n') .. ' > "tool chain/zig"',
				'chmod +x "tool chain/zig"',
			}
			for _, wrapper in ipairs(wrappers) do
				table.insert(script, 'printf %s ' .. shell_quote(wrapper.content) .. ' > "tool chain/' .. wrapper.name .. '"')
				table.insert(script, 'chmod +x "tool chain/' .. wrapper.name .. '"')
				table.insert(script, '"./tool chain/' .. wrapper.name .. '" "argument with spaces" "*"')
			end
			local status = core.test.resolve(core.task({
				inputs = { mkdir = core.native_tool("mkdir"), chmod = core.native_tool("chmod") },
				outputs = { status = core.output.value() },
				run = function(exec)
					local result = exec.action({
						argv = { "sh", "-ec", table.concat(script, "\n") },
						env = { PATH = "" },
						display = "test Zig wrappers without dirname",
					})
					return { status = { code = result.exit_code, stdout = result.stdout } }
				end,
			}).outputs.status)
			assert(status.code == 0, tostring(status.code))
			local args = "<argument with spaces>\n<*>\n"
			local expected = "<ar>\n" .. args .. "<ranlib>\n" .. args .. "<cc>\n" .. args .. "<ar>\n" .. args
			assert(status.stdout == expected, status.stdout)
		end),

		core.test.case("installs a toolchain on windows with .bat wrappers and a declared sh tool", function()
			with_zig_host(WINDOWS, function(host)
				zig.zig_toolchain("0.13.0", { default = true, unverified = true })
				install("0.13.0")
				local installed = host.runs[2]
				assert(contains(installed.argv[5], "zig-windows-x86_64-0.13.0.zip"), installed.argv[5])
				same(installed.tools, { "mkdir", "mv", "sh", "unzip" })
				assert(contains(installed.argv[3], "unzip -q"))
				assert(not contains(installed.argv[3], " tar "))
				assert(not contains(installed.argv[3], "chmod"))
				assert(has(installed.argv, "zigar.bat"))
				assert(has(installed.argv, "zigranlib.bat"))
				assert(has(installed.argv, '@"%~dp0zig.exe" ar %*\r\n'))
			end)
		end),

		core.test.case("uses legacy os-then-arch artifact naming through 0.14.0", function()
			assert(zig.artifact_name("0.13.0", LINUX) == "zig-linux-x86_64-0.13.0.tar.xz")
			assert(zig.artifact_name("0.14.0", WINDOWS) == "zig-windows-x86_64-0.14.0.zip")
		end),

		core.test.case("uses current arch-then-os artifact naming from 0.14.1 onward", function()
			assert(zig.artifact_name("0.14.1", LINUX) == "zig-x86_64-linux-0.14.1.tar.xz")
			assert(zig.artifact_name("0.16.0", { os = "windows", arch = "aarch64" }) == "zig-aarch64-windows-0.16.0.zip")
		end),

		core.test.case("treats non-numeric versions (dev builds) as current naming", function()
			assert(
				zig.artifact_name("0.17.0-dev.1267+300116b02", LINUX)
					== "zig-x86_64-linux-0.17.0-dev.1267+300116b02.tar.xz"
			)
		end),

		core.test.case("an unsupported platform fails by name", function()
			local text = error_text(zig.artifact_name, "0.16.0", { os = "macos", arch = "aarch64" })
			assert(contains(text, "unsupported Zig toolchain OS: macos"), text)
			text = error_text(zig.download_url, "0.16.0", { os = "linux", arch = "riscv64" })
			assert(contains(text, "unsupported Zig toolchain architecture: riscv64"), text)
			assert(#zig.supported_platforms() == 4)
		end),

		core.test.case("declares a graph-native zig toolchain with both tools and runs no action", function()
			with_zig_host(LINUX, function(host)
				assert(zig.default_graph_toolchain() == nil)
				zig.zig_toolchain("0.16.0", { default = true })
				local provider = zig.graph_toolchain("0.16.0")
				assert(type(provider.tool) == "userdata")
				assert(type(provider.build_cache_tool) == "userdata")
				assert(provider.version == "0.16.0")
				assert(zig.is_zig_toolchain(provider))
				assert(table.isfrozen(provider))
				assert(zig.default_graph_toolchain().version == "0.16.0")
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("the build cache is prewarmed into its named cache with the zig tool", function()
			with_zig_host(LINUX, function(host)
				zig.zig_toolchain("0.16.0", { default = true, unverified = true })
				local dir = core.test.resolve(core.task({
					inputs = { cache = zig.graph_build_cache_tool("0.16.0") },
					outputs = { value = core.output.value() },
					run = function(exec, inputs)
						return { value = exec.tool_dir(inputs.cache) }
					end,
				}).outputs.value)
				assert(dir == "/cache/zig-build-cache/shared", dir)
				local prewarm = host.runs[#host.runs]
				assert(prewarm.display == "prewarm zig build cache 0.16.0 (linux/x86_64)", prewarm.display)
				same(prewarm.tools, { "mkdir", "zig" })
				assert(contains(prewarm.argv[3], 'ZIG_GLOBAL_CACHE_DIR="$cachedir" zig cc'), prewarm.argv[3])
				assert(published(host, "zig-build-cache", "shared"))
			end)
		end),

		core.test.case("the provider gives both tools as task inputs and fails a CMake configure", function()
			with_zig_host(LINUX, function()
				zig.zig_toolchain("0.16.0", { default = true })
				local provider = zig.graph_toolchain("0.16.0")
				local inputs = provider.task_inputs()
				assert(inputs.cc_tool == provider.tool)
				assert(inputs.cc_build_cache_tool == provider.build_cache_tool)
				local text = error_text(provider.cmake_configure)
				assert(contains(text, "doesn't support a zig toolchain"), text)
				assert(not provider.resolves_tool_name("zig"))
				assert(provider.resolve_state() == nil)
				assert(next(provider.edge_env()) == nil)
			end)
		end),

		core.test.case("graph_cache_env points ZIG_GLOBAL_CACHE_DIR at the build-cache mount", function()
			local env = zig.graph_cache_env()
			assert(env.ZIG_GLOBAL_CACHE_DIR == ".imp/tools/zig-build-cache", env.ZIG_GLOBAL_CACHE_DIR)
		end),

		core.test.case("commands builds the zig compile, archive, and link tokens", function()
			with_zig_host(LINUX, function()
				zig.zig_toolchain("0.16.0", { default = true })
				local commands = zig.graph_toolchain("0.16.0").commands()
				assert(commands.env.ZIG_GLOBAL_CACHE_DIR == ".imp/tools/zig-build-cache")
				same(
					commands.compile_command({
						source = "a.cc",
						obj_path = "a.o",
						is_cxx = true,
						include_dirs = { "inc" },
						opt = "release",
						copts = {},
						is_shared = true,
					}),
					{ "'zig'", "'c++'", "-c", "'a.cc'", "-o", "'a.o'", "'-O2'", "'-DNDEBUG'", "'-fPIC'", "'-Iinc'" }
				)
				same(
					commands.archive_command({ out_path = "liba.a", rsp_path = "a.rsp" }),
					{ "'zig'", "'ar'", "rcs", "'liba.a'", "@'a.rsp'" }
				)
				same(
					commands.link_command({ out_path = "out/libm.so", is_cxx = false, is_shared = true, rsp_path = "m.rsp" }),
					{ "'zig'", "'cc'", "-shared", "'-Wl,-soname,libm.so'", "-o", "'out/libm.so'", "@'m.rsp'" }
				)
			end)
		end),
	}),

	core.test.suite("Zig workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_zig_host(LINUX, function(host)
				zig.zig_toolchain("0.16.0", { default = true })
				install("0.16.0")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_zig_host(LINUX, function(host)
				zig.zig_toolchain("0.14.0", { default = true, lockfile = `{TESTDATA}/custom.json` })
				install("0.14.0")
				assert(has(host.runs[1].argv, "beef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_zig_host(LINUX, function()
				local address = `{TESTDATA}/missing.json`
				zig.zig_toolchain("0.14.0", { default = true, lockfile = address })
				local text = error_text(install, "0.14.0")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_zig_host(LINUX, function()
				local text = error_text(zig.zig_toolchain, "0.14.0", { lockfile = "locks/zig.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_toolchain_host(LINUX, function(host)
				zig.reset_for_test()
				for _, plat in ipairs(zig.supported_platforms()) do
					host.set_run_stdout(`lock zig 0.14.0 {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
				end
				local declared = zig.zig_toolchain("0.14.0", { default = true, lockfile = "@workspace/locks/zig.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/zig.lock", result.path)
				local written = false
				for _, recorded in ipairs(host.runs) do
					if recorded.display == "write locks/zig.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/zig.lock")
			end)
		end),
	}),
}
