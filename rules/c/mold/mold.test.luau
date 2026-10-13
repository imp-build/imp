local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local mold = require("@imp/rules/c/mold")

local TESTDATA = "@imp/rules/c/mold/testdata"
local LINUX = { os = "linux", arch = "x86_64" }
local CACHE_DIR = "/cache/mold-toolchains/2.41.0/linux-x86_64"
-- The SHA-256 of mold 2.41.0 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "a3696680d99e692970590a178bc3a33d78d60d1c6dc9db7a11b557b02b751f5d"

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

--- Run `fn(host)` with the toolchain host fake on linux/x86_64, after the
--- module forgets the default that it declared when it loaded.
local function with_mold_host(fn)
	return core.test.with_fake_toolchain_host(LINUX, function(host)
		mold.reset_for_test()
		return fn(host)
	end)
end

--- A task that returns `fn(exec, tool)` for the mold tool of `version`.
local function with_mold_tool(version, fn)
	return core.task({
		inputs = { tool = mold.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = fn(exec, inputs.tool) }
		end,
	}).outputs.value
end

--- Install mold `version` with faked actions, and return the bin directory.
local function install(version)
	return core.test.resolve(with_mold_tool(version, function(exec, tool)
		return exec.tool_dir(tool) .. "/bin"
	end))
end

return {
	core.test.suite("mold toolchain", {
		core.test.case("declares a default mold toolchain", function()
			with_mold_host(function()
				local declared = mold.mold_toolchain("2.41.0", { default = true })
				assert(declared.version == "2.41.0")
				assert(declared.lockfile == "@imp/rules/c/mold/mold.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(mold.cache_key("2.41.0", LINUX) == "2.41.0/linux-x86_64")
				assert(mold.default_version() == "2.41.0")
				assert(mold.MOLD.default().version == "2.41.0")
			end)
		end),

		core.test.case("the module declares the pinned default on Linux", function()
			if core.platform_info().os == "linux" then
				assert(mold.default_version() == "2.42.1", tostring(mold.default_version()))
			else
				assert(mold.default_version() == nil)
			end
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_mold_host(function()
				mold.mold_toolchain("2.41.0")
				local text = error_text(mold.graph_toolchain)
				assert(contains(text, "no mold toolchain version specified"), text)
				assert(mold.default_graph_toolchain() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and extracts a toolchain with two sandboxed actions", function()
			with_mold_host(function(host)
				mold.mold_toolchain("2.41.0", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("2.41.0") == CACHE_DIR .. "/bin")
				assert(#host.runs == 2, tostring(#host.runs))

				local download, extract = host.runs[1], host.runs[2]
				-- The lock entry pins both the URL and the expected digest.
				assert(download.argv[1] == "sh")
				assert(has(download.argv, "https://locked.example/mold-2.41.0-x86_64-linux.tar.gz"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])
				assert(contains(extract.argv[3], "--strip-components=1"), extract.argv[3])
				assert(extract.display == "install mold 2.41.0 (linux/x86_64)", extract.display)

				local published = false
				for _, call in ipairs(host.calls) do
					if call[1] == "named_cache" and call[2] == "mold-toolchains" and call[3] == "2.41.0/linux-x86_64" then
						published = true
					end
				end
				assert(published, "the install publishes the mold-toolchains named cache")
			end)
		end),

		core.test.case("cold acquire without a lockfile fails pointing at gen-lockfiles", function()
			with_mold_host(function()
				mold.mold_toolchain("2.41.0", { default = true, lockfile = `{TESTDATA}/missing.json` })
				local text = error_text(install, "2.41.0")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("unverified downloads without a sha check", function()
			with_mold_host(function(host)
				mold.mold_toolchain("2.41.0", { default = true, unverified = true, lockfile = `{TESTDATA}/missing.json` })
				install("2.41.0")
				assert(#host.runs == 2)
				local download = host.runs[1]
				assert(not contains(download.argv[3], "sha256sum"), download.argv[3])
				assert(has(download.argv, "https://github.com/rui314/mold/releases/download/v2.41.0/mold-2.41.0-x86_64-linux.tar.gz"))
			end)
		end),

		core.test.case("a non-default unverified version needs no lockfile entry", function()
			with_mold_host(function(host)
				-- 2.41.0 has a shipped lockfile entry, and 9.9.9 does not. The
				-- unverified option comes from the instance that is installed,
				-- not from the default.
				mold.mold_toolchain("2.41.0", { default = true })
				mold.mold_toolchain("9.9.9", { unverified = true })
				install("9.9.9")
				assert(not contains(host.runs[1].argv[3], "sha256sum"), host.runs[1].argv[3])
			end)
		end),

		core.test.case("a non-default verified version needs a lockfile entry when the default is unverified", function()
			with_mold_host(function()
				mold.mold_toolchain("2.41.0", { default = true, unverified = true })
				mold.mold_toolchain("9.9.9")
				local text = error_text(install, "9.9.9")
				assert(contains(text, "mold 9.9.9"), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_mold_host(function(host)
				mold.mold_toolchain("2.41.0", { default = true })
				local graph = mold.graph_toolchain("2.41.0")
				assert(type(graph.tool) == "userdata")
				assert(graph.version == "2.41.0")
				assert(table.isfrozen(graph))
				assert(mold.default_graph_toolchain().version == "2.41.0")
				-- Building the graph only declares nodes. Nothing runs until a
				-- task is resolved.
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("rust_linker_env keeps the bare -fuse-ld=mold form and returns the named-cache bin directory", function()
			with_mold_host(function()
				mold.mold_toolchain("2.41.0", { default = true })
				-- This Bootlin-built gcc rejects an absolute -fuse-ld=<path>, so
				-- the flag keeps the PATH-search form, and path_dirs has the
				-- absolute bin directory for the caller to add to PATH.
				local env = core.test.resolve(with_mold_tool("2.41.0", mold.rust_linker_env))
				assert(#env.rustflags == 2 and env.rustflags[1] == "-C" and env.rustflags[2] == "link-arg=-fuse-ld=mold")
				assert(#env.path_dirs == 1 and env.path_dirs[1] == CACHE_DIR .. "/bin", env.path_dirs[1])
			end)
		end),

		core.test.case("odin_linker_env selects -linker:mold and returns the named-cache bin directory", function()
			with_mold_host(function()
				mold.mold_toolchain("2.41.0", { default = true })
				local env = core.test.resolve(with_mold_tool("2.41.0", mold.odin_linker_env))
				assert(#env.flags == 1 and env.flags[1] == "-linker:mold")
				assert(#env.path_dirs == 1 and env.path_dirs[1] == CACHE_DIR .. "/bin", env.path_dirs[1])
			end)
		end),

		core.test.case("an unsupported platform fails by name", function()
			assert(contains(error_text(mold.artifact_name, "2.41.0", { os = "macos", arch = "aarch64" }), "unsupported mold toolchain OS: macos"))
			assert(contains(error_text(mold.artifact_name, "2.41.0", { os = "linux", arch = "riscv64" }), "unsupported mold toolchain architecture: riscv64"))
			assert(#mold.supported_platforms() == 2)
		end),
	}),

	core.test.suite("mold workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_mold_host(function(host)
				mold.mold_toolchain("2.41.0", { default = true })
				install("2.41.0")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_mold_host(function(host)
				mold.mold_toolchain("2.40.0", { default = true, lockfile = `{TESTDATA}/custom.json` })
				install("2.40.0")
				assert(has(host.runs[1].argv, "beef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_mold_host(function()
				local address = `{TESTDATA}/missing.json`
				mold.mold_toolchain("2.40.0", { default = true, lockfile = address })
				local text = error_text(install, "2.40.0")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_mold_host(function()
				local text = error_text(mold.mold_toolchain, "2.40.0", { lockfile = "locks/mold.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_run(function(run)
				mold.reset_for_test()
				for _, plat in ipairs(mold.supported_platforms()) do
					run.set_run_stdout(`lock mold 2.40.0 {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
				end
				local declared = mold.mold_toolchain("2.40.0", { default = true, lockfile = "@workspace/locks/mold.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/mold.lock", result.path)
				local written = false
				for _, recorded in ipairs(run.runs) do
					if recorded.display == "write locks/mold.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/mold.lock")
			end)
		end),
	}),
}
