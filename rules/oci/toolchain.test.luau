local core = require("@imp/core")
local locks = require("@imp/rules/workflows/lockfiles")
local module = require("@imp/rules/oci/toolchain")
local VERSION = "0.22.1"
local CUSTOM = "@imp/rules/oci/testdata/locked.json"
local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end
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
		inputs = { tool = module.graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, input)
			return { value = module.crane_bin(exec, input.tool) }
		end,
	}).outputs.value)
end
return {
	core.test.case("crane declares the pinned default", function()
		assert(module.default_version() == VERSION)
	end),
	core.test.case("crane requires a default or a version", function()
		host_test(function()
			fails(module.graph_toolchain, "no crane toolchain version specified")
		end)
	end),
	core.test.case("crane graph construction does not execute acquisition", function()
		host_test(function(host)
			local declared = module.crane_toolchain(VERSION, { default = true })
			assert(type(declared[locks.GEN_LOCKFILES]) == "userdata")
			assert(declared.lockfile == "@imp/rules/oci/crane.lock")
			assert(type(module.graph_toolchain().tool) == "userdata")
			assert(table.isfrozen(module.graph_toolchain()))
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("crane verifies a custom lock and publishes the extracted cache", function()
		host_test(function(host)
			module.crane_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/crane-toolchains/" .. VERSION .. "/linux-x86_64/crane")
			assert(#host.runs == 2)
			assert(table.find(host.runs[1].argv, "https://locked.example/crane"))
			assert(table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
			assert(contains(host.runs[2].argv[3], "--strip-components") == false)
			assert(table.find(host.runs[2].argv, "crane-toolchain"))
			local published = false
			for _, call in ipairs(host.calls) do
				if
					call[1] == "named_cache"
					and call[2] == "crane-toolchains"
					and call[3] == VERSION .. "/linux-x86_64"
				then
					published = true
				end
			end
			assert(published)
			assert(table.find(host.runs[2].tools, "gzip"))
		end)
	end),
	core.test.case("crane uses the shipped lock by default", function()
		host_test(function(host)
			module.crane_toolchain(VERSION, { default = true })
			install()
			assert(not table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("crane reports missing and unlocked locks and malformed addresses", function()
		host_test(function()
			fails(function()
				module.crane_toolchain(VERSION, { lockfile = "relative.lock" })
			end, "must start with")
			module.crane_toolchain(VERSION, { default = true, lockfile = "@workspace/missing.lock" })
			fails(install, "no lockfile found")
		end)
		host_test(function()
			module.crane_toolchain("99.0.0", { default = true })
			fails(install, "gen-lockfiles")
		end)
	end),
	core.test.case("crane reports malformed lockfile JSON", function()
		host_test(function()
			module.crane_toolchain(VERSION, { default = true, lockfile = "@imp/rules/oci/testdata/invalid.lock" })
			fails(install, "is not valid JSON")
		end)
	end),
	core.test.case("crane permits an unverified version only when requested", function()
		host_test(function(host)
			module.crane_toolchain("99.0.0", { default = true, unverified = true })
			install()
			assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("crane preserves all platform mappings and Windows extraction", function()
		local expected = { "Linux_x86_64", "Linux_arm64", "Darwin_x86_64", "Darwin_arm64", "Windows_x86_64" }
		assert(#module.supported_platforms() == #expected)
		for index, plat in ipairs(module.supported_platforms()) do
			assert(module.artifact_name(VERSION, plat) == "go-containerregistry_" .. expected[index] .. ".tar.gz")
			assert(
				module.download_url(VERSION, plat)
					== "https://github.com/google/go-containerregistry/releases/download/v"
						.. VERSION
						.. "/"
						.. module.artifact_name(VERSION, plat)
			)
		end
		assert(module.cache_key(VERSION, { os = "linux", arch = "aarch64" }) == VERSION .. "/linux-aarch64")
		fails(function()
			module.artifact_name(VERSION, { os = "linux", arch = "riscv64" })
		end, "unsupported crane toolchain platform")
		host_test(function(host)
			module.crane_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/crane-toolchains/" .. VERSION .. "/windows-x86_64/crane.exe")
			assert(contains(host.runs[2].argv[3], "tar -xzf"))
			assert(contains(host.runs[2].argv[3], ".stage") == false)
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("crane generates the selected workspace lockfile", function()
		core.test.with_fake_run(function(host)
			module.reset_for_test()
			for _, plat in ipairs(module.supported_platforms()) do
				host.set_run_stdout(
					`lock crane {VERSION} {plat.os}/{plat.arch}`,
					string.rep("ab", 32) .. "  artifact\n  42\n"
				)
			end
			local declared =
				module.crane_toolchain(VERSION, { default = true, lockfile = "@workspace/locks/crane.lock" })
			local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
			assert(result.path == "locks/crane.lock", result.path)
		end)
	end),
}
