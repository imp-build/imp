local core = require("@imp/core")
local locks = require("@imp/rules/workflows/lockfiles")
local module = require("@imp/rules/js/node")
local VERSION = "26.8.2"
local CUSTOM = "@imp/rules/js/node/testdata/locked.json"
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
			return { value = module.node_bin(exec, input.tool) }
		end,
	}).outputs.value)
end
return {
	core.test.case("node declares the pinned default", function()
		assert(module.default_version() == VERSION)
	end),
	core.test.case("node requires a default or a version", function()
		host_test(function()
			fails(module.graph_toolchain, "no node toolchain version specified")
		end)
	end),
	core.test.case("node graph construction does not execute acquisition", function()
		host_test(function(host)
			local declared = module.node_toolchain(VERSION, { default = true })
			assert(type(declared[locks.GEN_LOCKFILES]) == "userdata")
			assert(declared.lockfile == "@imp/rules/js/node/node-toolchain.lock")
			assert(type(module.graph_toolchain().tool) == "userdata")
			assert(table.isfrozen(module.graph_toolchain()))
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("node verifies a custom lock and publishes the extracted cache", function()
		host_test(function(host)
			module.node_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/node-toolchains/" .. VERSION .. "/linux-x86_64/bin/node")
			assert(#host.runs == 2)
			assert(table.find(host.runs[1].argv, "https://locked.example/node"))
			assert(table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
			assert(contains(host.runs[2].argv[3], "--strip-components") == true)
			assert(table.find(host.runs[2].argv, "node-toolchain"))
		end)
	end),
	core.test.case("node uses the shipped lock by default", function()
		host_test(function(host)
			module.node_toolchain(VERSION, { default = true })
			install()
			assert(not table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("node reports missing, unlocked, and malformed locks", function()
		host_test(function()
			fails(function()
				module.node_toolchain(VERSION, { lockfile = "relative.lock" })
			end, "must start with")
			module.node_toolchain(VERSION, { default = true, lockfile = "@workspace/missing.lock" })
			fails(install, "no lockfile found")
		end)
		host_test(function()
			module.node_toolchain("99.0.0", { default = true })
			fails(install, "gen-lockfiles")
		end)
	end),
	core.test.case("node permits an unverified version only when requested", function()
		host_test(function(host)
			module.node_toolchain("99.0.0", { default = true, unverified = true })
			install()
			assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("node preserves platform mappings and Windows extraction", function()
		assert(#module.supported_platforms() == 5)
		assert(module.cache_key(VERSION, { os = "linux", arch = "aarch64" }) == VERSION .. "/linux-aarch64")
		fails(function()
			module.artifact_name(VERSION, { os = "linux", arch = "riscv64" })
		end, "unsupported node toolchain platform")
		host_test(function(host)
			module.node_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/node-toolchains/" .. VERSION .. "/windows-x86_64/node.exe")
			assert(contains(host.runs[2].argv[3], "unzip"))
			assert(contains(host.runs[2].argv[3], ".stage") == true)
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("node generates the selected workspace lockfile", function()
		core.test.with_fake_run(function(host)
			module.reset_for_test()
			for _, plat in ipairs(module.supported_platforms()) do
				host.set_run_stdout(
					`lock node-toolchain {VERSION} {plat.os}/{plat.arch}`,
					string.rep("ab", 32) .. "  artifact\n  42\n"
				)
			end
			local declared = module.node_toolchain(VERSION, { default = true, lockfile = "@workspace/locks/node.lock" })
			local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
			assert(result.path == "locks/node.lock", result.path)
		end)
	end),
}
