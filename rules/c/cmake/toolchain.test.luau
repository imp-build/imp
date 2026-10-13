-- Tests of the CMake toolchain. The toolchain host fake records each action
-- in place of a download or an extraction.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local cmake = require("@imp/rules/c/cmake/toolchain")

local TESTDATA = "@imp/rules/c/cmake/testdata"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local CACHE_DIR = "/cache/cmake-toolchains/3.30.5/linux-x86_64"
-- The SHA-256 of CMake 3.31.0 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "0fcb338b4515044f9ac77543550ac92c314c58f6f95aafcac5cd36aa75db6924"

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
	return table.find(list, value) ~= nil
end

--- Run `fn(host)` with the toolchain host fake on `platform` (the default is
--- Linux), after the module forgets the default that it declared on load.
local function with_cmake_host(platform, fn)
	if fn == nil then
		fn = platform
		platform = LINUX
	end
	return core.test.with_fake_toolchain_host(platform, function(host)
		cmake.reset_for_test()
		return fn(host)
	end)
end

--- Install CMake `version` with faked actions, and return the absolute path
--- of the cmake executable.
local function install(version)
	return core.test.resolve(core.task({
		inputs = { tool = cmake.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = cmake.cmake_bin(exec, inputs.tool) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("CMake toolchain", {
		core.test.case("declares a default CMake toolchain", function()
			with_cmake_host(function()
				local declared = cmake.cmake_toolchain("3.30.5", { default = true })
				assert(declared.version == "3.30.5")
				assert(declared.lockfile == "@imp/rules/c/cmake/cmake.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(cmake.cache_key("3.30.5", LINUX) == "3.30.5/linux-x86_64")
				assert(cmake.default_version() == "3.30.5")
				assert(cmake.CMAKE.default().version == "3.30.5")
			end)
		end),

		core.test.case("the module declares the pinned default", function()
			assert(cmake.default_version() == "4.4.3", tostring(cmake.default_version()))
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_cmake_host(function()
				local text = error_text(cmake.graph_toolchain)
				assert(contains(text, "no cmake toolchain version specified"), text)
				assert(cmake.default_graph_toolchain() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and extracts a toolchain with two sandboxed actions", function()
			with_cmake_host(function(host)
				cmake.cmake_toolchain("3.30.5", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("3.30.5") == CACHE_DIR .. "/bin/cmake")
				assert(#host.runs == 2, tostring(#host.runs))
				local download, extract = host.runs[1], host.runs[2]
				assert(download.argv[1] == "sh")
				assert(has(download.argv, "https://locked.example/cmake-3.30.5-linux-x86_64.tar.gz"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])
				assert(contains(extract.argv[3], "--strip-components=1"), extract.argv[3])
				assert(extract.display == "install cmake 3.30.5 (linux/x86_64)", extract.display)
				local published = false
				for _, call in ipairs(host.calls) do
					if call[1] == "named_cache" and call[2] == "cmake-toolchains" and call[3] == "3.30.5/linux-x86_64" then
						published = true
					end
				end
				assert(published, "the install publishes the cmake-toolchains named cache")
			end)
		end),

		core.test.case("extracts the Windows zip with unzip and gives cmake.exe", function()
			with_cmake_host(WINDOWS, function(host)
				cmake.cmake_toolchain("3.30.5", { default = true, lockfile = `{TESTDATA}/locked.json` })
				local bin = install("3.30.5")
				assert(bin == "/cache/cmake-toolchains/3.30.5/windows-x86_64/bin/cmake.exe", bin)
				assert(has(host.runs[1].argv, "https://locked.example/cmake-3.30.5-windows-x86_64.zip"))
				assert(contains(host.runs[2].argv[3], "unzip"), host.runs[2].argv[3])
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_cmake_host(function(host)
				cmake.cmake_toolchain("3.30.5", { default = true })
				local graph = cmake.graph_toolchain()
				assert(type(graph.tool) == "userdata")
				assert(graph.version == "3.30.5")
				assert(table.isfrozen(graph))
				assert(cmake.default_graph_toolchain().version == "3.30.5")
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("names release artifacts per platform", function()
			assert(cmake.artifact_name("4.4.3", LINUX) == "cmake-4.4.3-linux-x86_64.tar.gz")
			assert(cmake.artifact_name("4.4.3", { os = "windows", arch = "aarch64" }) == "cmake-4.4.3-windows-arm64.zip")
			assert(
				cmake.download_url("4.4.3", LINUX)
					== "https://github.com/Kitware/CMake/releases/download/v4.4.3/cmake-4.4.3-linux-x86_64.tar.gz"
			)
			assert(#cmake.supported_platforms() == 4)
		end),

		core.test.case("an unsupported platform fails by name", function()
			local os_text = error_text(cmake.artifact_name, "4.4.3", { os = "macos", arch = "aarch64" })
			assert(contains(os_text, "unsupported CMake toolchain OS: macos"), os_text)
			local arch_text = error_text(cmake.artifact_name, "4.4.3", { os = "linux", arch = "riscv64" })
			assert(contains(arch_text, "unsupported CMake toolchain architecture: riscv64"), arch_text)
		end),
	}),

	core.test.suite("CMake workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_cmake_host(function(host)
				cmake.cmake_toolchain("3.31.0", { default = true })
				install("3.31.0")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_cmake_host(function(host)
				cmake.cmake_toolchain("3.30.5", { default = true, lockfile = `{TESTDATA}/locked.json` })
				install("3.30.5")
				assert(has(host.runs[1].argv, "deadbeef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_cmake_host(function()
				local address = `{TESTDATA}/missing.json`
				cmake.cmake_toolchain("3.30.5", { default = true, lockfile = address })
				local text = error_text(install, "3.30.5")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_cmake_host(function()
				local text = error_text(cmake.cmake_toolchain, "3.30.5", { lockfile = "locks/cmake.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_run(function(run)
				cmake.reset_for_test()
				for _, plat in ipairs(cmake.supported_platforms()) do
					run.set_run_stdout(`lock cmake 3.30.5 {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
				end
				local declared = cmake.cmake_toolchain("3.30.5", { default = true, lockfile = "@workspace/locks/cmake.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/cmake.lock", result.path)
				local written = false
				for _, recorded in ipairs(run.runs) do
					if recorded.display == "write locks/cmake.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/cmake.lock")
			end)
		end),
	}),
}
