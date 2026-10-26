-- Tests of `@imp/rules/c/gcc`.
--
-- The JavaScript tests of `installGccToolchain`, `gccTool`, and `gccBin` are
-- not ported: the Luau module does not provide these functions (see the
-- header comment of the module).
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local gcc = require("@imp/rules/c/gcc")

local TESTDATA = "@imp/rules/c/gcc/testdata"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local CACHE_DIR = "/cache/gcc-toolchains/2025.08-1/linux-x86_64"
local WIN_VERSION = "16.1.0posix-14.0.0-ucrt-r4"
local WIN_CACHE_DIR = `/cache/gcc-toolchains/{WIN_VERSION}/windows-x86_64`
-- The SHA-256 of gcc 2025.08-1 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "760acd5c3159448b618e237b61935335baada74fe0cdc0d7611826cb49b41c8c"

--- Call `fn`, require that it fails, and return the error text.
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

local function published(host, key)
	for _, call in ipairs(host.calls) do
		if call[1] == "named_cache" and call[2] == "gcc-toolchains" and call[3] == key then
			return true
		end
	end
	return false
end

--- Run `fn(host)` with the toolchain host fake on `plat`, after the module
--- forgets the default that it declared when it loaded.
local function with_gcc_host(plat, fn)
	return core.test.with_fake_toolchain_host(plat, function(host)
		gcc.reset_for_test()
		return fn(host)
	end)
end

--- A task that returns `fn(exec, tool)` for the gcc tool of `version`.
local function with_gcc_tool(version, fn)
	return core.task({
		inputs = { tool = gcc.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = fn(exec, inputs.tool) }
		end,
	}).outputs.value
end

--- Install gcc `version` with faked actions, and return the install
--- directory.
local function install(version)
	return core.test.resolve(with_gcc_tool(version, gcc.graph_toolchain_dir))
end

return {
	core.test.suite("gcc toolchain", {
		core.test.case("declares a default gcc toolchain", function()
			with_gcc_host(LINUX, function()
				local declared = gcc.gcc_toolchain("2025.08-1", { default = true })
				assert(declared.version == "2025.08-1")
				assert(declared.lockfile == "@imp/rules/c/gcc/gcc.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(gcc.cache_key("2025.08-1", LINUX) == "2025.08-1/linux-x86_64")
				assert(gcc.default_version() == "2025.08-1")
				assert(gcc.GCC.default().version == "2025.08-1")
			end)
		end),

		core.test.case("the module declares the pinned default on a supported platform", function()
			local plat = core.platform_info()
			if plat.os == "linux" and plat.arch == "x86_64" then
				assert(gcc.default_version() == "2025.08-1", tostring(gcc.default_version()))
			elseif plat.os == "windows" and plat.arch == "x86_64" then
				assert(gcc.default_version() == "16.2.0posix-14.0.0-ucrt-r1", tostring(gcc.default_version()))
			else
				assert(gcc.default_version() == nil)
			end
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_gcc_host(LINUX, function()
				gcc.gcc_toolchain("2025.08-1")
				local text = error_text(gcc.graph_toolchain)
				assert(contains(text, "no gcc toolchain version specified"), text)
				assert(gcc.default_graph_toolchain() == nil)
			end)
		end),

		core.test.case(
			"downloads, verifies, and installs with two sandboxed actions that write the aliases",
			function()
				with_gcc_host(LINUX, function(host)
					gcc.gcc_toolchain("2025.08-1", { default = true, lockfile = `{TESTDATA}/locked.json` })
					assert(install("2025.08-1") == CACHE_DIR)
					assert(#host.runs == 2, tostring(#host.runs))

					local download, installed = host.runs[1], host.runs[2]
					assert(has(download.argv, "https://locked.example/x86-64--glibc--stable-2025.08-1.tar.xz"))
					assert(has(download.argv, "deadbeef"))
					assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])

					assert(installed.argv[1] == "sh")
					assert(installed.display == "install gcc 2025.08-1 (linux/x86_64)", installed.display)
					assert(contains(installed.argv[5], "x86-64--glibc--stable-2025.08-1.tar.xz"), installed.argv[5])
					same(installed.tools, { "chmod", "mkdir", "sh", "tar", "xz" })
					-- gcc and binutils have different prefixes, and the script
					-- receives both as arguments.
					assert(has(installed.argv, "x86_64-linux"))
					assert(has(installed.argv, "x86_64-buildroot-linux-gnu"))
					local script = installed.argv[3]
					for _, name in ipairs({ "clang", "cc", "c++", "ar", "ranlib" }) do
						assert(contains(script, `"{name}:$`), name)
					end
					assert(contains(script, "#!/bin/sh"))
					-- The escape-hatch aliases run .br_real directly, with the
					-- --sysroot that the Bootlin wrapper would add.
					for _, name in ipairs({ "clang-unsafe-paths", "cc-unsafe-paths", "c++-unsafe-paths" }) do
						assert(contains(script, `"{name}:$`), name)
					end
					assert(contains(script, ".br_real"))
					assert(contains(script, "--sysroot"))
					-- bin-unsafe-paths/ has scripts under the plain names, which
					-- run the real binary through "../bin/".
					assert(contains(script, '"$out/bin-unsafe-paths/$name"'))
					assert(contains(script, "/../bin/$target"))
					assert(
						published(host, "2025.08-1/linux-x86_64"),
						"the install publishes the gcc-toolchains named cache"
					)
				end)
			end
		),

		core.test.case("unverified downloads without a sha check", function()
			with_gcc_host(LINUX, function(host)
				gcc.gcc_toolchain(
					"2025.08-1",
					{ default = true, unverified = true, lockfile = `{TESTDATA}/missing.json` }
				)
				install("2025.08-1")
				assert(not contains(host.runs[1].argv[3], "sha256sum"), host.runs[1].argv[3])
				assert(
					has(
						host.runs[1].argv,
						"https://toolchains.bootlin.com/downloads/releases/toolchains/x86-64/tarballs/x86-64--glibc--stable-2025.08-1.tar.xz"
					)
				)
			end)
		end),

		core.test.case("cmake_compiler_args selects the plain or the -unsafe-paths compilers", function()
			with_gcc_host(LINUX, function()
				gcc.gcc_toolchain("2025.08-1", { default = true })
				local args = core.test.resolve(with_gcc_tool("2025.08-1", function(exec, tool)
					return {
						plain = gcc.cmake_compiler_args(exec, tool),
						unsafe = gcc.cmake_compiler_args(exec, tool, true),
					}
				end))
				same(args.plain, {
					`-DCMAKE_C_COMPILER={CACHE_DIR}/bin/clang`,
					`-DCMAKE_CXX_COMPILER={CACHE_DIR}/bin/c++`,
					`-DCMAKE_RANLIB={CACHE_DIR}/bin/ranlib`,
					`-DCMAKE_AR={CACHE_DIR}/bin/ar`,
				})
				same(args.unsafe, {
					`-DCMAKE_C_COMPILER={CACHE_DIR}/bin/clang-unsafe-paths`,
					`-DCMAKE_CXX_COMPILER={CACHE_DIR}/bin/c++-unsafe-paths`,
					`-DCMAKE_RANLIB={CACHE_DIR}/bin/ranlib`,
					`-DCMAKE_AR={CACHE_DIR}/bin/ar`,
				})
			end)
		end),

		core.test.case("the provider cmake_configure reads the cc_tool input", function()
			with_gcc_host(LINUX, function()
				gcc.gcc_toolchain("2025.08-1", { default = true })
				local provider = gcc.graph_toolchain("2025.08-1")
				local configured = core.test.resolve(core.task({
					inputs = provider.task_inputs(),
					outputs = { value = core.output.value() },
					run = function(exec, inputs)
						return { value = provider.cmake_configure(exec, inputs, { unsafe_system_paths = true }) }
					end,
				}).outputs.value)
				assert(configured.compiler_args[1] == `-DCMAKE_C_COMPILER={CACHE_DIR}/bin/clang-unsafe-paths`)
				assert(next(configured.env) == nil)
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_gcc_host(LINUX, function(host)
				assert(gcc.default_graph_toolchain() == nil)
				gcc.gcc_toolchain("2025.08-1", { default = true })
				local provider = gcc.graph_toolchain("2025.08-1")
				assert(type(provider.tool) == "userdata")
				assert(provider.version == "2025.08-1")
				assert(provider.kind == "gcc")
				assert(gcc.is_gcc_toolchain(provider))
				assert(table.isfrozen(provider))
				assert(gcc.default_graph_toolchain().version == "2025.08-1")
				-- Building the graph only declares nodes. Nothing runs until a
				-- task is resolved.
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("unsafe_system_paths selects a separate tool on bin-unsafe-paths", function()
			with_gcc_host(LINUX, function(host)
				gcc.gcc_toolchain("2025.08-1", { default = true })
				-- One task can declare both handles, because their names differ.
				local dirs = core.test.resolve(core.task({
					inputs = {
						plain = gcc.graph_tool("2025.08-1"),
						unsafe = gcc.graph_tool("2025.08-1", { unsafe_system_paths = true }),
					},
					outputs = { value = core.output.value() },
					run = function(exec, inputs)
						exec.action({ argv = { "true" }, display = "use both" })
						return { value = { exec.tool_dir(inputs.plain), exec.tool_dir(inputs.unsafe) } }
					end,
				}).outputs.value)
				-- Both handles use the same install.
				same(dirs, { CACHE_DIR, CACHE_DIR })
				local used = host.runs[#host.runs]
				assert(used.display == "use both")
				same(used.tools, { "gcc-toolchain", "gcc-toolchain-unsafe-paths" })
			end)
		end),

		core.test.case("the provider resolves the bare CMake replay tool names", function()
			local provider = gcc.toolchain_record(nil, "2025.08-1")
			for _, name in ipairs({ "clang", "c++", "ar", "ranlib", "nasm.exe", "cc-unsafe-paths" }) do
				assert(provider.resolves_tool_name(name), name)
			end
			assert(not provider.resolves_tool_name("cl.exe"))
			assert(provider.resolve_state() == nil)
			assert(next(provider.edge_env()) == nil)
		end),

		core.test.case("rust_link_driver_env uses the absolute named-cache path and sets CC", function()
			with_gcc_host(LINUX, function()
				gcc.gcc_toolchain("2025.08-1", { default = true })
				local env = core.test.resolve(with_gcc_tool("2025.08-1", function(exec, tool)
					return gcc.rust_link_driver_env(exec, tool, false)
				end))
				-- A relative linker path breaks, because rustc can start its
				-- linker in another directory. path_dirs has bin/, because
				-- cc-rs build scripts find "ar" through PATH.
				same(env.rustflags, { "-C", `linker={CACHE_DIR}/bin/clang` })
				assert(env.env.CC == `{CACHE_DIR}/bin/clang`, env.env.CC)
				assert(env.env.CXX == nil)
				same(env.path_dirs, { `{CACHE_DIR}/bin` })
			end)
		end),

		core.test.case("rust_link_driver_env runs CC and CXX through kache when kache is active", function()
			with_gcc_host(LINUX, function()
				gcc.gcc_toolchain("2025.08-1", { default = true })
				local env = core.test.resolve(with_gcc_tool("2025.08-1", function(exec, tool)
					return gcc.rust_link_driver_env(exec, tool, true)
				end))
				same(env.rustflags, { "-C", `linker={CACHE_DIR}/bin/clang` })
				assert(env.env.CC == `kache {CACHE_DIR}/bin/clang`, env.env.CC)
				assert(env.env.CXX == `kache {CACHE_DIR}/bin/c++`, env.env.CXX)
				same(env.path_dirs, { `{CACHE_DIR}/bin` })
			end)
		end),

		core.test.case("commands builds the compile, archive, and link tokens", function()
			with_gcc_host(LINUX, function()
				local commands = gcc.toolchain_record(nil, "2025.08-1").commands(nil, nil, nil)
				assert(next(commands.env) == nil)
				assert(commands.rsp_quote("a'b") == "'a'\\''b'")
				same(
					commands.compile_command({
						source = "src/a.c",
						obj_path = "out/a.o",
						is_cxx = false,
						include_dirs = { "include" },
						opt = "release",
						copts = { "-Wall" },
						is_shared = true,
					}),
					{
						"'clang'",
						"-c",
						"'src/a.c'",
						"-o",
						"'out/a.o'",
						"'-O2'",
						"'-DNDEBUG'",
						"'-fPIC'",
						"'-Iinclude'",
						"'-Wall'",
					}
				)
				same(
					commands.archive_command({ out_path = "out/liba.a", rsp_path = "out/a.rsp" }),
					{ "'ar'", "rcs", "'out/liba.a'", "@'out/a.rsp'" }
				)
				same(
					commands.link_command({
						out_path = "build/c/libm.so",
						is_cxx = true,
						is_shared = true,
						bundled = false,
						rsp_path = "m.rsp",
					}),
					{ "'c++'", "-shared", "'-Wl,-soname,libm.so'", "-o", "'build/c/libm.so'", "@'m.rsp'" }
				)
				same(
					commands.link_command({ out_path = "app", is_cxx = false, bundled = true, rsp_path = "app.rsp" }),
					{ "'clang'", "'-Wl,-rpath,$ORIGIN'", "-o", "'app'", "@'app.rsp'" }
				)
			end)
		end),

		core.test.case("commands uses the -unsafe-paths compilers with unsafe_system_paths", function()
			with_gcc_host(LINUX, function()
				local commands = gcc.toolchain_record(nil, "2025.08-1")
					.commands(nil, nil, { unsafe_system_paths = true })
				local tokens = commands.compile_command({
					source = "a.cc",
					obj_path = "a.o",
					is_cxx = true,
					include_dirs = {},
					opt = "debug",
					copts = {},
				})
				same(tokens, { "'c++-unsafe-paths'", "-c", "'a.cc'", "-o", "'a.o'", "'-O0'", "'-g'" })
			end)
		end),

		core.test.case("an unsupported platform fails by name", function()
			assert(
				contains(
					error_text(gcc.artifact_name, "2025.08-1", { os = "macos", arch = "aarch64" }),
					"unsupported gcc toolchain OS: macos"
				)
			)
			assert(
				contains(
					error_text(gcc.download_url, "2025.08-1", { os = "linux", arch = "aarch64" }),
					"unsupported gcc toolchain architecture: aarch64"
				)
			)
			same({ gcc.supported_platforms()[1].os, gcc.supported_platforms()[1].arch }, { "linux", "x86_64" })
		end),
	}),

	core.test.suite("gcc toolchain on windows", {
		core.test.case("an OS-keyed version resolves to the windows tag", function()
			with_gcc_host(WINDOWS, function()
				local declared = gcc.gcc_toolchain({ linux = "2025.08-1", windows = WIN_VERSION }, { default = true })
				assert(declared.version == WIN_VERSION)
				assert(declared.lockfile == "@imp/rules/c/gcc/gcc-windows.lock")
				assert(gcc.default_version() == WIN_VERSION)
				assert(gcc.cache_key(WIN_VERSION, WINDOWS) == `{WIN_VERSION}/windows-x86_64`)
				local text = error_text(gcc.gcc_toolchain, { linux = "2025.08-1" })
				assert(contains(text, "gcc toolchain version has no entry for platform 'windows'"), text)
			end)
		end),

		core.test.case("downloads, verifies, and installs with copies of gcc.exe and g++.exe", function()
			with_gcc_host(WINDOWS, function(host)
				gcc.gcc_toolchain(WIN_VERSION, { default = true, lockfile = `{TESTDATA}/locked-windows.json` })
				assert(install(WIN_VERSION) == WIN_CACHE_DIR)
				assert(#host.runs == 2, tostring(#host.runs))

				local download, installed = host.runs[1], host.runs[2]
				assert(
					has(
						download.argv,
						"https://locked.example/winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip"
					)
				)
				assert(has(download.argv, "deadbeef"))

				assert(installed.argv[1] == "sh")
				local script = installed.argv[3]
				-- unzip extracts the zip, not tar. A Windows tar can be the tar
				-- of Git for Windows, which cannot read zip.
				assert(contains(script, 'unzip -q "$archive"'), script)
				assert(not contains(script, "tar "), script)
				-- unzip has no --strip-components option, so the script moves
				-- the contents of the staging directory up.
				assert(contains(script, '"$out.stage"'))
				assert(contains(script, 'mv "$out.stage"/*/* "$out"/'))
				-- The aliases are copies of the real binaries, not wrapper
				-- scripts.
				assert(contains(script, 'cp "$out/bin/$target.exe"'))
				assert(not contains(script, "#!/bin/sh"))
				assert(not contains(script, "chmod"))
				for _, pair in ipairs({ "clang:gcc", "cc:gcc", "c++-unsafe-paths:c++" }) do
					assert(contains(script, `"{pair}"`), pair)
				end
				assert(contains(script, "bin-unsafe-paths"))
				assert(contains(script, "dlltool.exe"))
				same(installed.tools, { "cp", "mkdir", "mv", "sh", "unzip" })
				assert(published(host, `{WIN_VERSION}/windows-x86_64`))
			end)
		end),

		core.test.case("cmake_compiler_args and rust_link_driver_env add .exe and nasm on windows", function()
			with_gcc_host(WINDOWS, function()
				gcc.gcc_toolchain(WIN_VERSION, { default = true })
				local result = core.test.resolve(with_gcc_tool(WIN_VERSION, function(exec, tool)
					return {
						cmake = gcc.cmake_compiler_args(exec, tool),
						rust = gcc.rust_link_driver_env(exec, tool, false),
						archives = gcc.windows_runtime_archives(exec, tool, WIN_VERSION),
					}
				end))
				same(result.cmake, {
					`-DCMAKE_C_COMPILER={WIN_CACHE_DIR}/bin/clang.exe`,
					`-DCMAKE_CXX_COMPILER={WIN_CACHE_DIR}/bin/c++.exe`,
					`-DCMAKE_RANLIB={WIN_CACHE_DIR}/bin/ranlib.exe`,
					`-DCMAKE_AR={WIN_CACHE_DIR}/bin/ar.exe`,
					`-DCMAKE_ASM_NASM_COMPILER={WIN_CACHE_DIR}/bin/nasm.exe`,
				})
				same(result.rust.rustflags, { "-C", `linker={WIN_CACHE_DIR}/bin/clang.exe` })
				assert(result.rust.env.CC == `{WIN_CACHE_DIR}/bin/clang.exe`)
				same(result.rust.path_dirs, { `{WIN_CACHE_DIR}/bin` })
				assert(
					result.archives[1] == `{WIN_CACHE_DIR}/lib/gcc/x86_64-w64-mingw32/16.1.0/libgcc.a`,
					result.archives[1]
				)
				assert(result.archives[#result.archives] == `{WIN_CACHE_DIR}/x86_64-w64-mingw32/lib/libmsvcrt_shim.a`)
			end)
		end),

		core.test.case("commands adds -pipe and an import library, and no soname", function()
			with_gcc_host(WINDOWS, function()
				local commands = gcc.toolchain_record(nil, WIN_VERSION).commands(nil, nil, nil)
				local compile = commands.compile_command({
					source = "a.c",
					obj_path = "a.o",
					is_cxx = false,
					include_dirs = {},
					opt = "debug",
					copts = {},
					is_shared = true,
				})
				same(compile, { "'clang'", "'-pipe'", "-c", "'a.c'", "-o", "'a.o'", "'-O0'", "'-g'" })
				local link = commands.link_command({
					out_path = "out/m.dll",
					is_cxx = false,
					is_shared = true,
					bundled = true,
					rsp_path = "m.rsp",
				})
				same(
					link,
					{ "'clang'", "'-pipe'", "-shared", "'-Wl,--out-implib,out/m.lib'", "-o", "'out/m.dll'", "@'m.rsp'" }
				)
			end)
		end),

		core.test.case("gen-lockfiles writes the windows lockfile with the gcc-windows spec", function()
			core.test.with_fake_toolchain_host(WINDOWS, function(host)
				gcc.reset_for_test()
				host.set_run_stdout(
					`lock gcc-windows {WIN_VERSION} windows/x86_64`,
					string.rep("ab", 32) .. "  artifact\n  42\n"
				)
				local declared = gcc.gcc_toolchain(WIN_VERSION, { default = true })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "rules/c/gcc/gcc-windows.lock", result.path)
				local locked = false
				for _, recorded in ipairs(host.runs) do
					if recorded.display == `lock gcc-windows {WIN_VERSION} windows/x86_64` then
						locked = true
					end
					assert(not contains(recorded.display or "", "linux/"), recorded.display)
				end
				assert(locked, "a lock action for the gcc-windows spec")
			end)
		end),

		core.test.case("winlibs_gcc_version reads the GCC version of a tag", function()
			assert(gcc.winlibs_gcc_version(WIN_VERSION) == "16.1.0")
			local text = error_text(gcc.winlibs_gcc_version, "2025.08-1")
			assert(contains(text, "doesn't look like a WinLibs release tag"), text)
		end),
	}),

	core.test.suite("gcc workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_gcc_host(LINUX, function(host)
				gcc.gcc_toolchain("2025.08-1", { default = true })
				install("2025.08-1")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_gcc_host(LINUX, function(host)
				gcc.gcc_toolchain("2024.05-1", { default = true, lockfile = `{TESTDATA}/custom.json` })
				install("2024.05-1")
				assert(has(host.runs[1].argv, "beef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("an OS-keyed lockfile map selects the address of the host platform", function()
			with_gcc_host(LINUX, function(host)
				local declared =
					gcc.gcc_toolchain("2024.05-1", { default = true, lockfile = { linux = `{TESTDATA}/custom.json` } })
				assert(declared.lockfile == `{TESTDATA}/custom.json`)
				install("2024.05-1")
				assert(has(host.runs[1].argv, "beef"))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_gcc_host(LINUX, function()
				local address = `{TESTDATA}/missing.json`
				gcc.gcc_toolchain("2024.05-1", { default = true, lockfile = address })
				local text = error_text(install, "2024.05-1")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_gcc_host(LINUX, function()
				local text = error_text(gcc.gcc_toolchain, "2024.05-1", { lockfile = "locks/gcc.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_toolchain_host(LINUX, function(host)
				gcc.reset_for_test()
				for _, plat in ipairs(gcc.supported_platforms()) do
					host.set_run_stdout(
						`lock gcc 2024.05-1 {plat.os}/{plat.arch}`,
						string.rep("ab", 32) .. "  artifact\n  42\n"
					)
				end
				local declared =
					gcc.gcc_toolchain("2024.05-1", { default = true, lockfile = "@workspace/locks/gcc.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/gcc.lock", result.path)
				local written = false
				for _, recorded in ipairs(host.runs) do
					if recorded.display == "write locks/gcc.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/gcc.lock")
			end)
		end),
	}),
}
