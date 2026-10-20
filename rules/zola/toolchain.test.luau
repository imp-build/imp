local core = require("@imp/core")
local locks = require("@imp/rules/workflows/lockfiles")
local module = require("@imp/rules/zola")
local VERSION = "0.23.6"
local CUSTOM = "@imp/rules/zola/testdata/locked.json"
local function contains(text, part) return string.find(text, part, 1, true) ~= nil end
local function fails(fn, part)
	local ok, text = pcall(fn)
	assert(not ok and contains(tostring(text), part), tostring(text))
end
local function host_test(fn, platform)
	return core.test.with_fake_toolchain_host(platform or { os = "linux", arch = "x86_64" }, function(host)
		module.reset_for_test()
		return fn(host)
	end)
end
local function install()
	return core.test.resolve(core.task({
		inputs = { tool = module.graph_toolchain().tool }, outputs = { value = core.output.value() },
		run = function(exec, input) return { value = module.zola_bin(exec, input.tool) } end,
	}).outputs.value)
end
return {
	core.test.case("zola declares the pinned default", function()
		assert(module.default_version() == VERSION)
		local found = false
		for _, spec in ipairs(locks.builtin_lockfiles()) do
			if spec.name == "zola" then
				assert(table.concat(spec.versions, ",") == "0.22.1,0.23.6")
				assert(spec.lockfile == "@imp/rules/zola/zola.lock")
				found = true
			end
		end
		assert(found)
	end),
	core.test.case("zola requires a default or a version", function()
		host_test(function() fails(module.graph_toolchain, "no zola toolchain version specified") end)
	end),
	core.test.case("zola graph construction does not execute acquisition", function()
		host_test(function(host)
			local declared = module.zola_toolchain(VERSION, { default = true })
			assert(type(declared[locks.GEN_LOCKFILES]) == "userdata")
			assert(declared.lockfile == "@imp/rules/zola/zola.lock")
			assert(type(module.graph_toolchain().tool) == "userdata")
			assert(table.isfrozen(module.graph_toolchain()))
			assert(module.graph_toolchain() == module.graph_toolchain(VERSION))
			assert(module.resolve_version() == VERSION)
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("zola keeps explicit versions and replaces redeclared graphs", function()
		host_test(function()
			module.zola_toolchain(VERSION, { default = true })
			local original = module.graph_toolchain()
			module.zola_toolchain("0.22.1")
			assert(module.default_version() == VERSION)
			assert(module.graph_toolchain("0.22.1").version == "0.22.1")
			module.zola_toolchain(VERSION, { lockfile = CUSTOM })
			assert(module.graph_toolchain() ~= original)
			assert(module.ZOLA.instance_for_version(VERSION).lockfile == CUSTOM)
		end)
	end),
	core.test.case("zola verifies a custom lock and publishes the extracted cache", function()
		host_test(function(host)
			module.zola_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/zola-toolchains/" .. VERSION .. "/linux-x86_64/zola")
			assert(#host.runs == 2)
			assert(table.find(host.runs[1].argv, "https://locked.example/zola"))
			assert(table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
			assert(contains(host.runs[2].argv[3], "--strip-components") == false)
			assert(table.find(host.runs[2].argv, "zola-toolchain"))
			local published = false
			for _, call in ipairs(host.calls) do
				if call[1] == "named_cache" and call[2] == "zola-toolchains" and call[3] == VERSION .. "/linux-x86_64" then published = true end
			end
			assert(published)
			assert(table.find(host.runs[2].tools, "gzip"))
		end)
	end),
	core.test.case("zola uses the shipped lock by default", function()
		host_test(function(host)
			module.zola_toolchain(VERSION, { default = true })
			install()
			local lock = core.json_decode(core.read_file("@imp/rules/zola/zola.lock"))
			local entry = lock.versions[VERSION]["linux/x86_64"]
			assert(table.find(host.runs[1].argv, entry.url))
			assert(table.find(host.runs[1].argv, entry.sha256))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("zola reports missing and unlocked locks and malformed addresses", function()
		host_test(function()
			fails(function() module.zola_toolchain(VERSION, { lockfile = "relative.lock" }) end, "must start with")
			module.zola_toolchain(VERSION, { default = true, lockfile = "@workspace/missing.lock" })
			fails(install, "no lockfile found")
		end)
		host_test(function()
			module.zola_toolchain("99.0.0", { default = true })
			fails(install, "gen-lockfiles")
		end)
	end),
	core.test.case("zola reports malformed lockfile JSON", function()
		host_test(function()
			module.zola_toolchain(VERSION, { default = true, lockfile = "@imp/rules/zola/testdata/invalid.lock" })
			fails(install, "is not valid JSON")
		end)
	end),
	core.test.case("zola permits an unverified version only when requested", function()
		host_test(function(host)
			module.zola_toolchain("99.0.0", { default = true, unverified = true })
			install()
			assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("zola preserves all platform mappings and Windows extraction", function()
		local expected = { "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc" }
		assert(#module.supported_platforms() == #expected)
		for index, plat in ipairs(module.supported_platforms()) do
			assert(module.artifact_name(VERSION, plat) == "zola-v" .. VERSION .. "-" .. expected[index] .. (if plat.os == "windows" then ".zip" else ".tar.gz"))
			assert(module.download_url(VERSION, plat) == "https://github.com/getzola/zola/releases/download/v" .. VERSION .. "/" .. module.artifact_name(VERSION, plat))
		end
		assert(module.cache_key(VERSION, { os = "linux", arch = "aarch64" }) == VERSION .. "/linux-aarch64")
		fails(function() module.artifact_name(VERSION, { os = "linux", arch = "riscv64" }) end, "unsupported zola toolchain platform")
		host_test(function(host)
			module.zola_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/zola-toolchains/" .. VERSION .. "/windows-x86_64/zola.exe")
			assert(contains(host.runs[2].argv[3], "unzip"))
			assert(contains(host.runs[2].argv[3], ".stage") == false)
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("zola generates the selected workspace lockfile", function()
		core.test.with_fake_run(function(host)
			module.reset_for_test()
			for _, plat in ipairs(module.supported_platforms()) do
				host.set_run_stdout(`lock zola {VERSION} {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n")
			end
			local declared = module.zola_toolchain(VERSION, { default = true, lockfile = "@workspace/locks/zola.lock" })
			local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
			assert(result.path == "locks/zola.lock", result.path)
			assert(result.lock.tool == "zola")
			local count = 0
			for _, plat in ipairs(module.supported_platforms()) do
				local entry = result.lock.versions[VERSION][`{plat.os}/{plat.arch}`]
				assert(entry.sha256 == string.rep("ab", 32))
				assert(entry.size == 42)
				assert(entry.url == module.download_url(VERSION, plat))
				assert(entry.artifact == module.artifact_name(VERSION, plat))
				count += 1
			end
			assert(count == 5)
		end)
	end),
}
