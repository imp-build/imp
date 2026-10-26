-- Tests of the uv toolchain. The toolchain host fake records each action
-- in place of a download or an extraction.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local uv = require("@imp/rules/python/uv_toolchain")

local TESTDATA = "@imp/rules/python/testdata/uv"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local CACHE_DIR = "/cache/uv-toolchains/0.12.13/linux-x86_64"
-- The SHA-256 of uv 0.12.13 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd"

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
local function with_uv_host(platform, fn)
	if fn == nil then
		fn = platform
		platform = LINUX
	end
	return core.test.with_fake_toolchain_host(platform, function(host)
		uv.reset_for_test()
		return fn(host)
	end)
end

--- Install uv `version` with faked actions, and return the absolute path
--- of the uv executable.
local function install(version)
	return core.test.resolve(core.task({
		inputs = { tool = uv.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = uv.uv_bin(exec, inputs.tool) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("uv toolchain", {
		core.test.case("declares a default uv toolchain", function()
			with_uv_host(function()
				local declared = uv.uv_toolchain("0.12.13", { default = true })
				assert(declared.version == "0.12.13")
				assert(declared.lockfile == "@imp/rules/python/uv-toolchain.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(uv.cache_key("0.12.13", LINUX) == "0.12.13/linux-x86_64")
				assert(uv.default_version() == "0.12.13")
				assert(uv.UV.default().version == "0.12.13")
			end)
		end),

		core.test.case("the module declares the pinned default", function()
			assert(uv.default_version() == "0.12.13", tostring(uv.default_version()))
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_uv_host(function()
				local text = error_text(uv.graph_toolchain)
				assert(contains(text, "no uv toolchain version specified"), text)
				assert(uv.default_version() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and extracts a toolchain with two sandboxed actions", function()
			with_uv_host(function(host)
				uv.uv_toolchain("0.12.13", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("0.12.13") == CACHE_DIR .. "/uv")
				assert(#host.runs == 2, tostring(#host.runs))
				local download, extract = host.runs[1], host.runs[2]
				assert(download.argv[1] == "sh")
				assert(has(download.argv, "https://locked.example/uv"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])
				assert(contains(extract.argv[3], "--strip-components=1"), extract.argv[3])
				assert(extract.display == "install uv 0.12.13", extract.display)
				local published = false
				for _, call in ipairs(host.calls) do
					if
						call[1] == "named_cache"
						and call[2] == "uv-toolchains"
						and call[3] == "0.12.13/linux-x86_64"
					then
						published = true
					end
				end
				assert(published, "the install publishes the uv-toolchains named cache")
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_uv_host(function(host)
				uv.uv_toolchain("0.12.13", { default = true })
				local graph = uv.graph_toolchain()
				assert(type(graph.tool) == "userdata")
				assert(graph.version == "0.12.13")
				assert(table.isfrozen(graph))
				assert(uv.graph_toolchain().version == "0.12.13")
				assert(#host.runs == 0)
			end)
		end),
	}),

	core.test.suite("uv workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_uv_host(function(host)
				uv.uv_toolchain("0.12.13", { default = true })
				install("0.12.13")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_uv_host(function(host)
				uv.uv_toolchain("0.12.13", { default = true, lockfile = `{TESTDATA}/locked.json` })
				install("0.12.13")
				assert(has(host.runs[1].argv, "deadbeef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_uv_host(function()
				local address = `{TESTDATA}/missing.json`
				uv.uv_toolchain("0.12.13", { default = true, lockfile = address })
				local text = error_text(install, "0.12.13")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_uv_host(function()
				local text = error_text(uv.uv_toolchain, "0.12.13", { lockfile = "locks/uv.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_run(function(run)
				uv.reset_for_test()
				for _, plat in ipairs(uv.supported_platforms()) do
					run.set_run_stdout(
						`lock uv-toolchain 0.12.13 {plat.os}/{plat.arch}`,
						string.rep("ab", 32) .. "  artifact\n  42\n"
					)
				end
				local declared = uv.uv_toolchain("0.12.13", { default = true, lockfile = "@workspace/locks/uv.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/uv.lock", result.path)
				local written = false
				for _, recorded in ipairs(run.runs) do
					if recorded.display == "write locks/uv.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/uv.lock")
			end)
		end),
	}),

	core.test.suite("uv persistent cache", {
		core.test.case("seeds once and derives absolute environment paths", function()
			with_uv_host(function(host)
				uv.uv_toolchain("0.12.13", { default = true })
				local graph = uv.graph_toolchain()
				assert(graph.cache_tool == uv.graph_toolchain().cache_tool)
				local function resolve()
					return core.test.resolve(core.task({
						inputs = { cache = graph.cache_tool },
						outputs = { value = core.output.value() },
						run = function(exec, inputs)
							return { value = uv.cache_env(exec, inputs.cache) }
						end,
					}).outputs.value)
				end
				local env = resolve()
				assert(env.UV_CACHE_DIR == "/cache/uv-cache-dir/shared", tostring(env.UV_CACHE_DIR))
				resolve()
				assert(#host.runs == 1, tostring(#host.runs))
			end)
		end),
		core.test.case("unverified mode permits an unlocked version", function()
			with_uv_host(function(host)
				uv.uv_toolchain("99.0.0", { default = true, unverified = true })
				install("99.0.0")
				assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
			end)
		end),
		core.test.case("an unlocked version fails with a generation hint", function()
			with_uv_host(function()
				uv.uv_toolchain("99.0.0", { default = true })
				local text = error_text(install, "99.0.0")
				assert(contains(text, "no entry"), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),
	}),

	core.test.suite("uv platform contract", {
		core.test.case("preserves artifact names and cache keys", function()
			assert(uv.artifact_name("0.12.13", WINDOWS) == "uv-x86_64-pc-windows-msvc.zip")
			assert(uv.artifact_name("0.12.13", { os = "macos", arch = "aarch64" }) == "uv-aarch64-apple-darwin.tar.gz")
			assert(uv.cache_key("0.12.13", WINDOWS) == "0.12.13/windows-x86_64")
			assert(#uv.supported_platforms() == 5)
			assert(
				contains(
					error_text(uv.artifact_name, "0.12.13", { os = "linux", arch = "riscv64" }),
					"unsupported uv toolchain platform: linux/riscv64"
				)
			)
		end),
		core.test.case("installs on Windows", function()
			with_uv_host(WINDOWS, function(host)
				uv.uv_toolchain("0.12.13", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("0.12.13") == "/cache/uv-toolchains/0.12.13/windows-x86_64/uv.exe")
				assert(contains(host.runs[2].argv[3], "unzip"))
				assert(not contains(host.runs[2].argv[3], "--strip-components"))
			end)
		end),
	}),
}
