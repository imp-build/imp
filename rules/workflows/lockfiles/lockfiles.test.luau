local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")

local builtin = require("@imp/rules/workflows/builtin_lockfiles")

local TESTDATA = "@imp/rules/workflows/lockfiles/testdata"

local PLATFORMS = {
	{ os = "linux", arch = "x86_64" },
	{ os = "macos", arch = "aarch64" },
}

local function spec(overrides)
	local result = {
		name = "demo",
		platforms = PLATFORMS,
		download_url = function(version, plat)
			return `https://example.test/demo-{version}-{plat.os}-{plat.arch}.tar.gz`
		end,
		artifact_name = function(version, plat)
			return `demo-{version}-{plat.os}-{plat.arch}.tar.gz`
		end,
	}
	for key, value in pairs(overrides or {}) do
		result[key] = value
	end
	return result
end

--- The fake SHA-256 of an artifact: 64 hex digits that end with the version
--- digits, then `a` for x86_64 or `b` for aarch64. For example, `0…0200b`.
local function fake_sha(version, plat)
	local digits = string.gsub(version, "%.", "")
	local suffix = digits .. (if plat.arch == "x86_64" then "a" else "b")
	return string.rep("0", 64 - #suffix) .. suffix
end

local LINUX = PLATFORMS[1]
local MACOS = PLATFORMS[2]

--- Resolve a lockfile task with faked actions. Each download prints a
--- SHA-256 and a size that come from its version and platform. Returns the
--- task result and the recorded runs.
local function resolve(task, versions)
	return core.test.with_fake_run(function(run)
		for _, version in ipairs(versions) do
			for _, plat in ipairs(PLATFORMS) do
				local key = `{plat.os}/{plat.arch}`
				run.set_run_stdout(
					`lock demo {version} {key}`,
					`{fake_sha(version, plat)}  artifact\n` .. `  {#version + #plat.arch}\n`
				)
			end
		end
		return core.test.resolve(task), run.runs
	end)
end

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return table.concat(keys, ",")
end

--- The text that the write action puts into the lockfile.
local function written_text(runs)
	local write = runs[#runs]
	assert(write.display == "write " .. write.outputs.lockfile, write.display)
	local source = write.inputs[1]
	assert(write.input_count == 1)
	assert(write.argv[6] == source.path)
	return core.read_file_in_digest(source.digest, source.path)
end

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

return {

	core.test.suite("shipped toolchains", {
		core.test.case("registers every shipped lockfile and declares its root", function()
			local specs = lockfiles.builtin_lockfiles()
			local roots = builtin.builtin_lockfile_roots()
			local names = {}
			assert(#roots == #specs)
			for i, item in ipairs(specs) do
				table.insert(names, item.name)
				assert(#item.versions > 0)
				assert(string.sub(item.lockfile, 1, 11) == "@imp/rules/")
				assert(roots[i].address == item.lockfile)
			end
			table.sort(names)
			assert(table.concat(names, ",") == "biome-toolchain,cmake,crane,gcc,gcc-windows,kache,mold,nasm,node-toolchain,odin,odinfmt,pex-toolchain,pnpm-toolchain,ruff-toolchain,rust,uv-toolchain,zig,zola")
		end),
		core.test.case("all declared roots regenerate exactly their registered versions", function()
			local specs = lockfiles.builtin_lockfiles()
			local roots = builtin.builtin_lockfile_roots()
			core.test.with_fake_run(function(run)
				for _, item in ipairs(specs) do
					for _, version in ipairs(item.versions) do
						for _, plat in ipairs(item.platforms) do
							run.set_run_stdout(`lock {item.name} {version} {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
						end
					end
				end
				for i, entry in ipairs(roots) do
					local result = core.test.resolve(entry.root)
					local versions = table.clone(specs[i].versions)
					table.sort(versions)
					assert(result.lock.tool == specs[i].name)
					assert(sorted_keys(result.lock.versions) == table.concat(versions, ","))
				end
			end)
		end),
		core.test.case("platforms: odin/toolchain", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/odin/toolchain").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64,macos/x86_64,macos/aarch64,windows/x86_64", table.concat(keys, ","))
		end),
		core.test.case("platforms: c/cmake/toolchain", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/c/cmake/toolchain").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64,windows/x86_64,windows/aarch64", table.concat(keys, ","))
		end),
		core.test.case("platforms: c/gcc", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/c/gcc").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64", table.concat(keys, ","))
		end),
		core.test.case("platforms: c/mold", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/c/mold").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64", table.concat(keys, ","))
		end),
		core.test.case("platforms: c/zig", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/c/zig").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64,windows/x86_64,windows/aarch64", table.concat(keys, ","))
		end),
		core.test.case("platforms: zola", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/zola").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64,macos/x86_64,macos/aarch64,windows/x86_64", table.concat(keys, ","))
		end),
		core.test.case("platforms: rust/toolchain", function()
			local keys = {}
			for _, plat in ipairs(require("@imp/rules/rust/toolchain").supported_platforms()) do
				table.insert(keys, `{plat.os}/{plat.arch}`)
			end
			assert(table.concat(keys, ",") == "linux/x86_64,linux/aarch64,macos/x86_64,macos/aarch64,windows/x86_64", table.concat(keys, ","))
		end),
	}),
	core.test.suite("graph_generate_tool_lockfile", {
		core.test.case("pins the url, artifact, size, and sha256 of each platform", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({ version = "2.0.0" }))
			local result, runs = resolve(task, { "2.0.0" })
			assert(result.path == "demo.lock", result.path)
			assert(result.lock.tool == "demo")
			local entry = result.lock.versions["2.0.0"]["macos/aarch64"]
			assert(entry.url == "https://example.test/demo-2.0.0-macos-aarch64.tar.gz", entry.url)
			assert(entry.artifact == "demo-2.0.0-macos-aarch64.tar.gz", entry.artifact)
			assert(entry.sha256 == fake_sha("2.0.0", MACOS), tostring(entry.sha256))
			assert(entry.size == 12, tostring(entry.size))
			assert(#runs == 3, tostring(#runs))
			assert(runs[1].cache == false, "downloads are not cached")
			assert(runs[1].argv[6] == "https://example.test/demo-2.0.0-linux-x86_64.tar.gz", runs[1].argv[6])
		end),

		core.test.case("keeps the other locked versions and replaces the relocked version", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({
				version = "3.0.0",
				lockfile = `{TESTDATA}/demo.json`,
			}))
			local result, runs = resolve(task, { "3.0.0" })
			assert(result.path == "rules/workflows/lockfiles/testdata/demo.json", result.path)
			assert(sorted_keys(result.lock.versions) == "1.0.0,3.0.0", sorted_keys(result.lock.versions))
			assert(result.lock.versions["1.0.0"]["linux/x86_64"].sha256 == "aaaa")
			local relocked = result.lock.versions["3.0.0"]
			assert(sorted_keys(relocked) == "linux/x86_64,macos/aarch64", sorted_keys(relocked))
			assert(relocked["linux/x86_64"].artifact == "demo-3.0.0-linux-x86_64.tar.gz")
			local text = written_text(runs)
			assert(string.find(text, '"1.0.0"', 1, true) < string.find(text, '"3.0.0"', 1, true), text)
		end),

		core.test.case("folds a legacy single-version lockfile in", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({
				version = "2.0.0",
				lockfile = `{TESTDATA}/legacy.json`,
			}))
			local result = resolve(task, { "2.0.0" })
			assert(sorted_keys(result.lock.versions) == "0.9.0,2.0.0", sorted_keys(result.lock.versions))
			assert(result.lock.versions["0.9.0"]["linux/x86_64"].sha256 == "bbbb")
		end),

		core.test.case("ignores a lock for another tool, invalid JSON, and a missing file", function()
			for _, name in ipairs({ "other.json", "invalid.json", "missing.json" }) do
				local task = lockfiles.graph_generate_tool_lockfile(spec({
					version = "2.0.0",
					lockfile = `{TESTDATA}/{name}`,
				}))
				local result = resolve(task, { "2.0.0" })
				assert(sorted_keys(result.lock.versions) == "2.0.0", `{name}: {sorted_keys(result.lock.versions)}`)
			end
		end),

		core.test.case("writes the lock as JSON in the field and platform order", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({ version = "2.0.0" }))
			local _, runs = resolve(task, { "2.0.0" })
			local expected = table.concat({
				"{",
				'  "tool": "demo",',
				'  "versions": {',
				'    "2.0.0": {',
				'      "linux/x86_64": {',
				'        "url": "https://example.test/demo-2.0.0-linux-x86_64.tar.gz",',
				'        "artifact": "demo-2.0.0-linux-x86_64.tar.gz",',
				'        "size": 11,',
				`        "sha256": "{fake_sha("2.0.0", LINUX)}"`,
				"      },",
				'      "macos/aarch64": {',
				'        "url": "https://example.test/demo-2.0.0-macos-aarch64.tar.gz",',
				'        "artifact": "demo-2.0.0-macos-aarch64.tar.gz",',
				'        "size": 12,',
				`        "sha256": "{fake_sha("2.0.0", MACOS)}"`,
				"      }",
				"    }",
				"  }",
				"}",
				"",
			}, "\n")
			local text = written_text(runs)
			assert(text == expected, text)
		end),

		core.test.case("keeps the platform order of the file for an existing version", function()
			-- 1.0.0 in the fixture has the platforms in another order than the
			-- declared order, and one platform that is not declared.
			local task = lockfiles.graph_generate_tool_lockfile(spec({
				version = "2.0.0",
				lockfile = `{TESTDATA}/reordered.json`,
			}))
			local _, runs = resolve(task, { "2.0.0" })
			local text = written_text(runs)
			local fixture = core.read_file(`{TESTDATA}/reordered.json`)
			local old = string.match(fixture, '\n(    "1%.0%.0": {.-\n    })')
			assert(old ~= nil, fixture)
			assert(contains(text, old), text)
			local linux = string.find(text, '"linux/x86_64"', string.find(text, '"2.0.0"', 1, true), true)
			local macos = string.find(text, '"macos/aarch64"', string.find(text, '"2.0.0"', 1, true), true)
			assert(linux < macos, "a new version uses the declared order")
		end),

		core.test.case("fails when a download prints no SHA-256 and size", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({ version = "2.0.0" }))
			local text = error_text(function()
				core.test.with_fake_run(function()
					core.test.resolve(task)
				end)
			end)
			assert(contains(text, "could not read the SHA-256 and size"), text)
		end),

		core.test.case("fails when the SHA-256 does not have 64 hex digits", function()
			local task = lockfiles.graph_generate_tool_lockfile(spec({ version = "2.0.0" }))
			local text = error_text(function()
				core.test.with_fake_run(function(run)
					run.set_run_stdout("lock demo 2.0.0 linux/x86_64", `{fake_sha("2.0.0", LINUX)}  artifact\n  5\n`)
					run.set_run_stdout("lock demo 2.0.0 macos/aarch64", "abc123  artifact\n  5\n")
					core.test.resolve(task)
				end)
			end)
			assert(contains(text, "could not read the SHA-256 and size"), text)
		end),
	}),

	core.test.suite("encode_lock", {
		-- Regeneration must not reorder a shipped lockfile. The encoder writes
		-- each decoded lockfile again with the same bytes.
		core.test.case("writes the shipped lockfiles with the same bytes", function()
			for _, address in ipairs({
				"@imp/rules/zola/zola.lock",
				"@imp/rules/js/node/node-toolchain.lock",
				"@imp/rules/odin/odin.lock",
				"@imp/rules/rust/rust.lock",
				"@imp/rules/c/gcc/gcc.lock",
				"@imp/rules/python/uv-toolchain.lock",
				`{TESTDATA}/demo.json`,
			}) do
				local text = core.read_file(address)
				assert(text ~= nil, address)
				-- The platform order of each version in the file.
				local orders = {}
				local version = nil
				for line in string.gmatch(text, "[^\n]+") do
					local key = string.match(line, '^    "(.-)": {')
					if key ~= nil then
						version = key
						orders[version] = {}
					end
					key = string.match(line, '^      "(.-)": {')
					if key ~= nil then
						table.insert(orders[version], key)
					end
				end
				local encoded = lockfiles.encode_lock(core.json_decode(text), orders)
				assert(encoded == text, `{address}:\n{encoded}`)
			end
		end),

		core.test.case("escapes quotes, backslashes, and control characters", function()
			local text = lockfiles.encode_lock({
				tool = 'a"b\\c\n\1',
				versions = {},
			})
			assert(text == '{\n  "tool": "a\\"b\\\\c\\n\\u0001",\n  "versions": {}\n}\n', text)
		end),

		core.test.case("writes DEL without an escape, as JSON.stringify does", function()
			local text = lockfiles.encode_lock({ tool = "a\127b", versions = {} })
			assert(text == '{\n  "tool": "a\127b",\n  "versions": {}\n}\n', text)
		end),
	}),

	core.test.suite("graph_gen_lockfiles_goal", {
		core.test.case("writes each tool lockfile and reports the tools", function()
			core.test.with_fake_write_workspace(function(write)
				local report = lockfiles.graph_gen_lockfiles_goal({
					{
						address = "//tools:demo",
						result = {
							lock = { tool = "demo", versions = {} },
							path = "rules/demo/demo.lock",
							lockfile = { type = "artifact", digest = "digest", path = "rules/demo/demo.lock" },
						},
					},
				})
				assert(report == "gen-lockfiles: regenerated 1 lockfile(s): demo", report)
				assert(#write.calls == 1)
				assert(write.calls[1].path == "rules/demo/demo.lock")
				assert(write.calls[1].digest == "digest")
				assert(write.calls[1].from == "rules/demo/demo.lock")
			end)
		end),

		core.test.case("writes a Python project lock to its path", function()
			core.test.with_fake_write_workspace(function(write)
				local report = lockfiles.graph_gen_lockfiles_goal({
					{
						address = "//py:workspace",
						result = {
							kind = "python-project-lock",
							project = "app",
							path = "py/uv.lock",
							lockfile = { type = "artifact", digest = "lock", path = "py/uv.lock" },
						},
					},
				})
				assert(report == "gen-lockfiles: regenerated 1 lockfile(s): Python app", report)
				assert(write.calls[1].path == "py/uv.lock" and write.calls[1].from == "py/uv.lock")
			end)
		end),

		-- Each root merges with the lockfile that it read when the graph was
		-- declared, so the second write would remove the versions of the
		-- first.
		core.test.case("rejects two roots that write the same lockfile, before it writes", function()
			local function root(address, version)
				return {
					address = address,
					result = {
						lock = { tool = "demo", versions = { [version] = {} } },
						path = "rules/demo/demo.lock",
						lockfile = { type = "artifact", digest = version, path = "rules/demo/demo.lock" },
					},
				}
			end
			core.test.with_fake_write_workspace(function(write)
				local text = error_text(lockfiles.graph_gen_lockfiles_goal, {
					root("//tools:a", "1.0.0"),
					root("//tools:b", "2.0.0"),
				})
				assert(contains(text, "//tools:a and //tools:b both write rules/demo/demo.lock"), text)
				assert(#write.calls == 0)
			end)
		end),

		core.test.case("rejects a root that is not a lockfile result", function()
			core.test.with_fake_write_workspace(function(write)
				local text = error_text(lockfiles.graph_gen_lockfiles_goal, {
					{ address = "//pkg:bad", result = { tool = "demo" } },
				})
				assert(contains(text, "//pkg:bad: gen-lockfiles graph root must resolve"), text)
				assert(#write.calls == 0)
			end)
		end),
	}),

	core.test.suite("builtin lockfiles", {
		core.test.case("registration requires a lockfile address and versions", function()
			local text = error_text(lockfiles.register_builtin_lockfile, spec({ versions = { "1.0.0" } }))
			assert(contains(text, "builtin lockfile for 'demo' must declare a lockfile address"), text)
			text = error_text(lockfiles.register_builtin_lockfile, spec({ lockfile = `{TESTDATA}/demo.json`, versions = {} }))
			assert(contains(text, "builtin lockfile for 'demo' must declare at least one version"), text)
		end),

		core.test.case("register_toolchain_lockfile registers the versions and returns the spec", function()
			local toolchain = spec({ lockfile = `{TESTDATA}/demo.json` })
			local before = #lockfiles.builtin_lockfiles()
			assert(lockfiles.register_toolchain_lockfile(toolchain, { "2.0.0" }) == toolchain)
			local registered = lockfiles.builtin_lockfiles()
			assert(#registered == before + 1)
			assert(registered[#registered].versions[1] == "2.0.0")
			assert(toolchain.versions == nil, "the spec of the caller does not change")
		end),

		core.test.case("regeneration writes exactly the registered versions", function()
			local task = lockfiles.generate_builtin_lockfile(spec({
				lockfile = `{TESTDATA}/demo.json`,
				versions = { "2.0.0" },
			}))
			local result = resolve(task, { "2.0.0" })
			assert(sorted_keys(result.lock.versions) == "2.0.0", sorted_keys(result.lock.versions))
			assert(result.path == "rules/workflows/lockfiles/testdata/demo.json", result.path)
		end),
	}),
}
