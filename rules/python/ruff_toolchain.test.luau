-- Tests of the ruff toolchain. The toolchain host fake records each action
-- in place of a download or an extraction.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local ruff = require("@imp/rules/python/ruff_toolchain")

local TESTDATA = "@imp/rules/python/testdata/ruff"
local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local CACHE_DIR = "/cache/ruff-toolchains/0.16.7/linux-x86_64"
-- The SHA-256 of ruff 0.16.7 for linux/x86_64 in the shipped lockfile.
local SHIPPED_SHA = "73894c7b7c9a53fd66ed715eb3a1ec65077f316328e377057a98bdb7fcba0326"

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
local function with_ruff_host(platform, fn)
	if fn == nil then
		fn = platform
		platform = LINUX
	end
	return core.test.with_fake_toolchain_host(platform, function(host)
		ruff.reset_for_test()
		return fn(host)
	end)
end

--- Install ruff `version` with faked actions, and return the absolute path
--- of the ruff executable.
local function install(version)
	return core.test.resolve(core.task({
		inputs = { tool = ruff.graph_toolchain(version).tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = ruff.ruff_bin(exec, inputs.tool) }
		end,
	}).outputs.value)
end

return {
	core.test.suite("ruff toolchain", {
		core.test.case("declares a default ruff toolchain", function()
			with_ruff_host(function()
				local declared = ruff.ruff_toolchain("0.16.7", { default = true })
				assert(declared.version == "0.16.7")
				assert(declared.lockfile == "@imp/rules/python/ruff-toolchain.lock")
				assert(type(declared[lockfiles.GEN_LOCKFILES]) == "userdata")
				assert(ruff.cache_key("0.16.7", LINUX) == "0.16.7/linux-x86_64")
				assert(ruff.default_version() == "0.16.7")
				assert(ruff.RUFF.default().version == "0.16.7")
			end)
		end),

		core.test.case("the module declares the pinned default", function()
			assert(ruff.default_version() == "0.16.7", tostring(ruff.default_version()))
		end),

		core.test.case("fails when no version is given and no default is set", function()
			with_ruff_host(function()
				local text = error_text(ruff.graph_toolchain)
				assert(contains(text, "no ruff toolchain version specified"), text)
				assert(ruff.default_version() == nil)
			end)
		end),

		core.test.case("downloads, verifies, and extracts a toolchain with two sandboxed actions", function()
			with_ruff_host(function(host)
				ruff.ruff_toolchain("0.16.7", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("0.16.7") == CACHE_DIR .. "/ruff")
				assert(#host.runs == 2, tostring(#host.runs))
				local download, extract = host.runs[1], host.runs[2]
				assert(download.argv[1] == "sh")
				assert(has(download.argv, "https://locked.example/ruff"))
				assert(has(download.argv, "deadbeef"))
				assert(contains(download.argv[3], "sha256sum -c -"), download.argv[3])
				assert(contains(extract.argv[3], "--strip-components=1"), extract.argv[3])
				assert(extract.display == "install ruff 0.16.7", extract.display)
				local published = false
				for _, call in ipairs(host.calls) do
					if
						call[1] == "named_cache"
						and call[2] == "ruff-toolchains"
						and call[3] == "0.16.7/linux-x86_64"
					then
						published = true
					end
				end
				assert(published, "the install publishes the ruff-toolchains named cache")
			end)
		end),

		core.test.case("graph toolchain construction runs no action", function()
			with_ruff_host(function(host)
				ruff.ruff_toolchain("0.16.7", { default = true })
				local graph = ruff.graph_toolchain()
				assert(type(graph.tool) == "userdata")
				assert(graph.version == "0.16.7")
				assert(table.isfrozen(graph))
				assert(ruff.graph_toolchain().version == "0.16.7")
				assert(#host.runs == 0)
			end)
		end),
	}),

	core.test.suite("ruff workspace lockfile selection", {
		core.test.case("the shipped lockfile is the default", function()
			with_ruff_host(function(host)
				ruff.ruff_toolchain("0.16.7", { default = true })
				install("0.16.7")
				assert(has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a custom lockfile address is read instead of the shipped one", function()
			with_ruff_host(function(host)
				ruff.ruff_toolchain("0.16.7", { default = true, lockfile = `{TESTDATA}/locked.json` })
				install("0.16.7")
				assert(has(host.runs[1].argv, "deadbeef"))
				assert(not has(host.runs[1].argv, SHIPPED_SHA))
			end)
		end),

		core.test.case("a missing selected lockfile fails naming it and gen-lockfiles", function()
			with_ruff_host(function()
				local address = `{TESTDATA}/missing.json`
				ruff.ruff_toolchain("0.16.7", { default = true, lockfile = address })
				local text = error_text(install, "0.16.7")
				assert(contains(text, "no lockfile found"), text)
				assert(contains(text, address), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),

		core.test.case("a malformed lockfile address fails at declaration", function()
			with_ruff_host(function()
				local text = error_text(ruff.ruff_toolchain, "0.16.7", { lockfile = "locks/ruff.lock" })
				assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
			end)
		end),

		core.test.case("gen-lockfiles writes the address declared on the toolchain", function()
			core.test.with_fake_run(function(run)
				ruff.reset_for_test()
				for _, plat in ipairs(ruff.supported_platforms()) do
					run.set_run_stdout(
						`lock ruff-toolchain 0.16.7 {plat.os}/{plat.arch}`,
						string.rep("ab", 32) .. "  artifact\n  42\n"
					)
				end
				local declared =
					ruff.ruff_toolchain("0.16.7", { default = true, lockfile = "@workspace/locks/ruff.lock" })
				local result = core.test.resolve(declared[lockfiles.GEN_LOCKFILES])
				assert(result.path == "locks/ruff.lock", result.path)
				local written = false
				for _, recorded in ipairs(run.runs) do
					if recorded.display == "write locks/ruff.lock" then
						written = true
					end
				end
				assert(written, "a write action for locks/ruff.lock")
			end)
		end),
	}),

	core.test.suite("ruff verification", {
		core.test.case("unverified mode permits an unlocked version", function()
			with_ruff_host(function(host)
				ruff.ruff_toolchain("99.0.0", { default = true, unverified = true })
				install("99.0.0")
				assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
			end)
		end),
		core.test.case("an unlocked version fails with a generation hint", function()
			with_ruff_host(function()
				ruff.ruff_toolchain("99.0.0", { default = true })
				local text = error_text(install, "99.0.0")
				assert(contains(text, "no entry"), text)
				assert(contains(text, "gen-lockfiles"), text)
			end)
		end),
	}),

	core.test.suite("Ruff local install", {
		core.test.case("rejects undeclared host paths", function()
			assert(
				contains(
					error_text(ruff.install_ruff_toolchain, "local", "/tmp/ruff"),
					"declared directory artifact or path handle"
				)
			)
		end),
		core.test.case("publishes a local directory in a content-keyed cache", function()
			with_ruff_host(function(host)
				local source = core.task({
					outputs = { directory = core.output.artifact() },
					run = function(exec)
						return {
							directory = exec.action({
								argv = { "sh", "-c", "true" },
								outputs = { directory = core.output.directory("local") },
							}).outputs.directory,
						}
					end,
				})
				ruff.install_ruff_toolchain("local", source.outputs.directory, { default = true })
				local path = install("local")
				assert(contains(path, "/cache/ruff-local-toolchains/local/linux-x86_64/"), path)
				assert(string.sub(path, -5) == "/ruff", path)
				assert(#host.runs == 3)
				assert(host.runs[3].display == "install local ruff local")
			end)
		end),
	}),

	core.test.suite("ruff platform contract", {
		core.test.case("preserves artifact names and cache keys", function()
			assert(ruff.artifact_name("0.16.7", WINDOWS) == "ruff-x86_64-pc-windows-msvc.zip")
			assert(
				ruff.artifact_name("0.16.7", { os = "macos", arch = "aarch64" }) == "ruff-aarch64-apple-darwin.tar.gz"
			)
			assert(ruff.cache_key("0.16.7", WINDOWS) == "0.16.7/windows-x86_64")
			assert(#ruff.supported_platforms() == 5)
			assert(
				contains(
					error_text(ruff.artifact_name, "0.16.7", { os = "linux", arch = "riscv64" }),
					"unsupported ruff toolchain platform: linux/riscv64"
				)
			)
		end),
		core.test.case("installs on Windows", function()
			with_ruff_host(WINDOWS, function(host)
				ruff.ruff_toolchain("0.16.7", { default = true, lockfile = `{TESTDATA}/locked.json` })
				assert(install("0.16.7") == "/cache/ruff-toolchains/0.16.7/windows-x86_64/ruff.exe")
				assert(contains(host.runs[2].argv[3], "unzip"))
				assert(not contains(host.runs[2].argv[3], "--strip-components"))
			end)
		end),
	}),
}
