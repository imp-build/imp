local core = require("@imp/core")
local lockfile = require("@imp/rules/imp/lockfile")

local RUFF = "@imp/rules/imp/testdata/lockfile/ruff.json"
local INVALID = "@imp/rules/imp/testdata/lockfile/invalid.json"
local MISSING = "@imp/rules/imp/testdata/lockfile/missing.json"
local PLAT = { os = "linux", arch = "x86_64" }

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function resolve(overrides)
	local options = { address = RUFF, tool = "ruff-toolchain", version = "0.15.21", plat = PLAT }
	for key, value in pairs(overrides or {}) do
		options[key] = value
	end
	return lockfile.resolve_tool_lockfile(options)
end

local function same_list(actual, expected)
	if #actual ~= #expected then
		return false
	end
	for index, value in ipairs(expected) do
		if actual[index] ~= value then
			return false
		end
	end
	return true
end

-- The JavaScript module also tests `lockfileFor`, which reads the lockfile
-- address of a declared Toolchain instance. Luau has no Toolchain class yet,
-- so that helper waits for the Luau toolchain module.
return {
	core.test.suite("lockfile addresses", {
		core.test.case("converts a lockfile address to a workspace-relative path", function()
			assert(lockfile.lockfile_address_to_path("@imp/rules/python/ruff-toolchain.lock") == "rules/python/ruff-toolchain.lock")
			assert(lockfile.lockfile_address_to_path("@workspace/tools/ruff.lock") == "tools/ruff.lock")
			local text = error_text(lockfile.lockfile_address_to_path, "@workspace/../escape.lock")
			assert(contains(text, "workspace-relative"), text)
			text = error_text(lockfile.lockfile_address_to_path, "//rules/python/ruff-toolchain.lock")
			assert(contains(text, "must start with @workspace/ or @imp/rules/"), text)
		end),
	}),

	core.test.suite("lockfile resolution", {
		core.test.case("resolves a matching lockfile entry", function()
			local entry = resolve()
			assert(entry.sha256 == "abc123")
			assert(entry.size == 12345)
			assert(entry.url == "https://example.com/ruff.tar.gz")
		end),

		core.test.case("every locked version stays resolvable", function()
			local entry = resolve({ version = "0.14.0" })
			assert(entry.sha256 == "def456")
			assert(entry.size == nil)
		end),

		core.test.case("a missing lockfile fails with a gen-lockfiles pointer", function()
			local text = error_text(resolve, { address = MISSING })
			assert(contains(text, `no lockfile found at {MISSING} for ruff-toolchain 0.15.21`), text)
			assert(contains(text, "imp goal gen-lockfiles"), text)
		end),

		core.test.case("an invalid lockfile fails", function()
			local text = error_text(resolve, { address = INVALID })
			assert(contains(text, `lockfile {INVALID} is not valid JSON`), text)
		end),

		core.test.case("a different tool fails", function()
			local text = error_text(resolve, { tool = "other-tool" })
			assert(contains(text, "pins ruff-toolchain, not other-tool"), text)
		end),

		core.test.case("an unlocked version fails and lists the locked versions", function()
			local text = error_text(resolve, { version = "9.9.9" })
			assert(contains(text, "has no entry for ruff-toolchain 9.9.9 (locked versions: 0.14.0, 0.15.21)"), text)
		end),

		core.test.case("a missing platform entry fails", function()
			local text = error_text(resolve, { plat = { os = "macos", arch = "aarch64" } })
			assert(contains(text, "on platform macos/aarch64"), text)
		end),

		core.test.case("unverified makes a miss return nil", function()
			assert(resolve({ address = MISSING, unverified = true }) == nil)
			assert(resolve({ version = "9.9.9", unverified = true }) == nil)
		end),
	}),

	core.test.suite("download scripts", {
		core.test.case("selects the sha tool for each platform", function()
			assert(lockfile.sha_tool_name({ os = "linux" }) == "sha256sum")
			assert(lockfile.sha_tool_name({ os = "windows" }) == "sha256sum")
			assert(lockfile.sha_tool_name({ os = "macos" }) == "shasum")
		end),

		core.test.case("lists the download tools for each platform", function()
			assert(same_list(lockfile.locked_download_tools({ os = "linux" }), { "curl", "mkdir", "dirname", "wc", "sha256sum" }))
			assert(same_list(lockfile.locked_download_tools({ os = "macos" }), { "curl", "mkdir", "dirname", "wc", "shasum" }))
			assert(
				same_list(
					lockfile.locked_download_tools({ os = "windows" }),
					{ "curl", "mkdir", "dirname", "wc", "sha256sum", "sh" }
				)
			)
		end),

		core.test.case("locked download argv verifies sha256 and size", function()
			local argv = lockfile.locked_download_argv({
				plat = PLAT,
				lock_entry = { url = "https://example.com/a.tgz", sha256 = "abc", size = 42 },
				url = "https://example.com/a.tgz",
				download_path = ".imp/a.tgz",
				display_name = "download-a",
			})
			assert(argv[1] == "sh" and argv[2] == "-c")
			assert(contains(argv[3], "sha256sum -c -"), argv[3])
			assert(contains(argv[3], "size mismatch"), argv[3])
			assert(same_list({ table.unpack(argv, 4) }, { "download-a", ".imp/a.tgz", "https://example.com/a.tgz", "abc", "42" }))
		end),

		core.test.case("locked download argv skips the size check without a size", function()
			local argv = lockfile.locked_download_argv({
				plat = { os = "macos" },
				lock_entry = { url = "u", sha256 = "abc" },
				url = "u",
				download_path = "a",
				display_name = "download-a",
			})
			assert(contains(argv[3], "shasum -a 256 -c -"), argv[3])
			assert(not contains(argv[3], "size mismatch"), argv[3])
			assert(#argv == 7)
		end),

		core.test.case("locked download argv without a lock entry is a plain download", function()
			local argv = lockfile.locked_download_argv({
				plat = PLAT,
				url = "https://example.com/a.tgz",
				download_path = "a.tgz",
				display_name = "download-a",
			})
			assert(same_list(argv, {
				"sh",
				"-c",
				'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"',
				"download-a",
				"a.tgz",
				"https://example.com/a.tgz",
			}))
		end),
	}),

	core.test.suite("download_tool_artifact", {
		core.test.case("requires a non-empty output", function()
			local text = error_text(lockfile.download_tool_artifact, { lockfile = RUFF, tool = "ruff-toolchain", plat = PLAT })
			assert(contains(text, "requires a non-empty output"), text)
		end),

		core.test.case("returns an artifact handle and does not run", function()
			core.test.with_fake_toolchain_host(function(host)
				local artifact = lockfile.download_tool_artifact({
					lockfile = RUFF,
					tool = "ruff-toolchain",
					version = "0.15.21",
					plat = PLAT,
					output = ".imp/ruff.tar.gz",
				})
				assert(type(artifact) == "userdata")
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("runs a verified download from the lock entry", function()
			core.test.with_fake_toolchain_host(function(host)
				core.test.resolve(lockfile.download_tool_artifact({
					lockfile = RUFF,
					tool = "ruff-toolchain",
					version = "0.15.21",
					plat = PLAT,
					url = "https://fallback.example.com",
					output = ".imp/ruff.tar.gz",
				}))
				assert(#host.runs == 1)
				local run = host.runs[1]
				assert(run.display == "download ruff-toolchain")
				assert(run.argv[4] == "download-ruff-toolchain")
				assert(run.argv[6] == "https://example.com/ruff.tar.gz")
				assert(run.argv[7] == "abc123")
				assert(run.outputs.artifact == ".imp/ruff.tar.gz")
				assert(same_list(run.tools, { "curl", "dirname", "mkdir", "sh", "sha256sum", "wc" }))
			end)
		end),

		core.test.case("resolves the lock entry under lock_plat", function()
			core.test.with_fake_toolchain_host(function(host)
				core.test.resolve(lockfile.download_tool_artifact({
					lockfile = RUFF,
					tool = "ruff-toolchain",
					version = "0.14.0",
					plat = { os = "macos", arch = "aarch64" },
					lock_plat = { os = "any", arch = "any" },
					output = "ruff.pex",
				}))
				local run = host.runs[1]
				assert(run.argv[6] == "https://example.com/ruff-any.pex")
				assert(contains(run.argv[3], "shasum -a 256 -c -"), run.argv[3])
			end)
		end),

		core.test.case("an unverified miss downloads the fallback URL", function()
			core.test.with_fake_toolchain_host(function(host)
				core.test.resolve(lockfile.download_tool_artifact({
					lockfile = MISSING,
					tool = "ruff-toolchain",
					version = "0.15.21",
					plat = PLAT,
					url = "https://fallback.example.com/ruff.tgz",
					output = "ruff.tgz",
					unverified = true,
				}))
				local run = host.runs[1]
				assert(run.argv[6] == "https://fallback.example.com/ruff.tgz")
				assert(#run.argv == 6)
			end)
		end),

		core.test.case("adds a gen-lockfiles pointer to a failed verified download", function()
			core.test.with_fake_toolchain_host(function(host)
				host.set_run_exit_code("download ruff-toolchain", 1)
				local artifact = lockfile.download_tool_artifact({
					lockfile = RUFF,
					tool = "ruff-toolchain",
					version = "0.15.21",
					plat = PLAT,
					output = ".imp/ruff.tar.gz",
				})
				local text = error_text(core.test.resolve, artifact)
				assert(contains(text, "download of ruff-toolchain 0.15.21 from https://example.com/ruff.tar.gz"), text)
				assert(contains(text, `expected abc123 from {RUFF}`), text)
				assert(contains(text, "imp goal gen-lockfiles"), text)
			end)
		end),
	}),
}
