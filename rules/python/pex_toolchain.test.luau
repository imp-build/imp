-- Tests of the pex toolchain. The toolchain host fake records each action
-- in place of a download or an extraction.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local pex = require("@imp/rules/python/pex_toolchain")

local TESTDATA = "@imp/rules/python/testdata/pex"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local CACHE_DIR = "/cache/pex-toolchains/2.102.0"
-- The SHA-256 of pex 2.102.0 for any/any in the shipped lockfile.
local SHIPPED_SHA = "bc13a30fe36d29628442c150e41f3542dc4f89b83f7de2ab42f3e4b1f6d41e06"

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
local function with_pex_host(platform, fn)
	if fn == nil then
		fn = platform
		platform = LINUX
	end
	return core.test.with_fake_toolchain_host(platform, function(host)
		pex.reset_for_test()
		return fn(host)
	end)
end

--- Install pex `version` with faked actions, and return the absolute path
--- of the pex executable.
local function install(version)
	return core.test.resolve(core.task({
		inputs = { tool = pex.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = pex.pex_bin(exec, inputs.tool) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("pex toolchain", {
		core.test.case("declares a default pex toolchain", function()
			with_pex_host(function()
				local declared = pex.pex_toolchain("2.102.0", { default = true })
				assert(declared.version == "2.102.0")
				assert(declared.lockfile == "@imp/rules/python/pex-toolchain.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(pex.cache_key("2.102.0", LINUX) == "2.102.0")
				assert(pex.default_version() == "2.102.0")
				assert(pex.PEX.default().version == "2.102.0")
			end)
		end),

		core.test.case("the module declares the pinned default", function()
			assert(pex.default_version() == "2.102.0", tostring(pex.default_version()))
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_pex_host(function()
				local text = error_text(pex.graph_toolchain)
				assert(contains(text, "no pex toolchain version specified"), text)
				assert(pex.default_version() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and installs a toolchain with two sandboxed actions", function()
			with_pex_host(function(host)
				pex.pex_toolchain("2.102.0", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("2.102.0") == CACHE_DIR .. "/pex")
				assert(#host.runs == 2, tostring(#host.runs))
				local download, extract = host.runs[1], host.runs[2]
				assert(download.argv[1] == "sh")
				assert(has(download.argv, "https://locked.example/pex"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])
				assert(contains(extract.argv[3], "chmod +x"), extract.argv[3])
				assert(extract.display == "install pex 2.102.0", extract.display)
				local published = false
				for _, call in ipairs(host.calls) do
					if call[1] == "named_cache" and call[2] == "pex-toolchains" and call[3] == "2.102.0" then
						published = true
					end
				end
				assert(published, "the install publishes the pex-toolchains named cache")
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_pex_host(function(host)
				pex.pex_toolchain("2.102.0", { default = true })
				local graph = pex.graph_toolchain()
				assert(type(graph.tool) == "userdata")
				assert(graph.version == "2.102.0")
				assert(table.isfrozen(graph))
				assert(pex.graph_toolchain().version == "2.102.0")
				assert(#host.runs == 0)
			end)
		end),

	}),

	core.test.suite("pex workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_pex_host(function(host)
				pex.pex_toolchain("2.102.0", { default = true })
				install("2.102.0")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_pex_host(function(host)
				pex.pex_toolchain("2.102.0", { default = true, lockfile = `{TESTDATA}/locked.json` })
				install("2.102.0")
				assert(has(host.runs[1].argv, "deadbeef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_pex_host(function()
				local address = `{TESTDATA}/missing.json`
				pex.pex_toolchain("2.102.0", { default = true, lockfile = address })
				local text = error_text(install, "2.102.0")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_pex_host(function()
				local text = error_text(pex.pex_toolchain, "2.102.0", { lockfile = "locks/pex.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_run(function(run)
				pex.reset_for_test()
				for _, plat in ipairs(pex.supported_platforms()) do
					run.set_run_stdout(`lock pex-toolchain 2.102.0 {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
				end
				local declared = pex.pex_toolchain("2.102.0", { default = true, lockfile = "@workspace/locks/pex.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/pex.lock", result.path)
				local written = false
				for _, recorded in ipairs(run.runs) do
					if recorded.display == "write locks/pex.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/pex.lock")
			end)
		end),
	}),

	core.test.suite("pex persistent cache", {
		core.test.case("seeds once and derives absolute environment paths", function()
			with_pex_host(function(host)
				pex.pex_toolchain("2.102.0", { default = true })
				local graph = pex.graph_toolchain()
				assert(graph.cache_tool == pex.graph_toolchain().cache_tool)
				local function resolve()
					return core.test.resolve(core.task({ inputs = { cache = graph.cache_tool }, outputs = { value = core.output.value() },
						run = function(exec, inputs) return { value = pex.cache_env(exec, inputs.cache) } end,
					}).outputs.value)
				end
				local env = resolve()
				assert(env.PEX_ROOT == "/cache/pex-root/shared", tostring(env.PEX_ROOT))
				resolve()
				assert(#host.runs == 1, tostring(#host.runs))
			end)
		end),
		core.test.case("unverified mode permits an unlocked version", function()
			with_pex_host(function(host)
				pex.pex_toolchain("99.0.0", { default = true, unverified = true })
				install("99.0.0")
				assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
			end)
		end),
		core.test.case("an unlocked version fails with a generation hint", function()
			with_pex_host(function()
				pex.pex_toolchain("99.0.0", { default = true })
				local text = error_text(install, "99.0.0")
				assert(contains(text, "no entry"), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),
	}),

	core.test.suite("pex platform contract", {
		core.test.case("preserves artifact names and cache keys", function()
			assert(pex.artifact_name("2.102.0", WINDOWS) == "pex")
			assert(pex.cache_key("2.102.0", WINDOWS) == "2.102.0")
			assert(pex.download_url("2.102.0") == "https://github.com/pantsbuild/pex/releases/download/v2.102.0/pex")
			assert(#pex.supported_platforms() == 1)
		end),
		core.test.case("installs on Windows", function()
			with_pex_host(WINDOWS, function(host)
				pex.pex_toolchain("2.102.0", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("2.102.0") == "/cache/pex-toolchains/2.102.0/pex")
				assert(contains(host.runs[2].argv[3], "cp"))
				assert(not contains(host.runs[2].argv[3], "chmod"))
			end)
		end),
	}),
}
