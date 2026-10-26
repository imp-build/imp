local core = require("@imp/core")
local locks = require("@imp/rules/workflows/lockfiles")
local module = require("@imp/rules/js/pnpm")
local VERSION = "12.4.1"
local CUSTOM = "@imp/rules/js/pnpm/testdata/locked.json"
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
			return { value = module.pnpm_bin(exec, input.tool) }
		end,
	}).outputs.value)
end
return {
	core.test.case("pnpm declares the pinned default", function()
		assert(module.default_version() == VERSION)
	end),
	core.test.case("pnpm requires a default or a version", function()
		host_test(function()
			fails(module.graph_toolchain, "no pnpm toolchain version specified")
		end)
	end),
	core.test.case("pnpm graph construction does not execute acquisition", function()
		host_test(function(host)
			local declared = module.pnpm_toolchain(VERSION, { default = true })
			assert(type(declared[locks.GEN_LOCKFILES]) == "userdata")
			assert(declared.lockfile == "@imp/rules/js/pnpm/pnpm-toolchain.lock")
			assert(type(module.graph_toolchain().tool) == "userdata")
			assert(table.isfrozen(module.graph_toolchain()))
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("pnpm verifies a custom lock and publishes the extracted cache", function()
		host_test(function(host)
			module.pnpm_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/pnpm-toolchains/" .. VERSION .. "/linux-x86_64/pnpm")
			assert(#host.runs == 2)
			assert(table.find(host.runs[1].argv, "https://locked.example/pnpm"))
			assert(table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
			assert(contains(host.runs[2].argv[3], "--strip-components") == false)
			assert(table.find(host.runs[2].argv, "pnpm-toolchain"))
		end)
	end),
	core.test.case("pnpm uses the shipped lock by default", function()
		host_test(function(host)
			module.pnpm_toolchain(VERSION, { default = true })
			install()
			assert(not table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("pnpm reports missing, unlocked, and malformed locks", function()
		host_test(function()
			fails(function()
				module.pnpm_toolchain(VERSION, { lockfile = "relative.lock" })
			end, "must start with")
			module.pnpm_toolchain(VERSION, { default = true, lockfile = "@workspace/missing.lock" })
			fails(install, "no lockfile found")
		end)
		host_test(function()
			module.pnpm_toolchain("99.0.0", { default = true })
			fails(install, "gen-lockfiles")
		end)
	end),
	core.test.case("pnpm permits an unverified version only when requested", function()
		host_test(function(host)
			module.pnpm_toolchain("99.0.0", { default = true, unverified = true })
			install()
			assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("pnpm preserves platform mappings and Windows extraction", function()
		assert(#module.supported_platforms() == 5)
		assert(module.cache_key(VERSION, { os = "linux", arch = "aarch64" }) == VERSION .. "/linux-aarch64")
		fails(function()
			module.artifact_name(VERSION, { os = "linux", arch = "riscv64" })
		end, "unsupported pnpm toolchain platform")
		host_test(function(host)
			module.pnpm_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/pnpm-toolchains/" .. VERSION .. "/windows-x86_64/pnpm.exe")
			assert(contains(host.runs[2].argv[3], "unzip"))
			assert(contains(host.runs[2].argv[3], ".stage") == false)
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("pnpm generates the selected workspace lockfile", function()
		core.test.with_fake_run(function(host)
			module.reset_for_test()
			for _, plat in ipairs(module.supported_platforms()) do
				host.set_run_stdout(
					`lock pnpm-toolchain {VERSION} {plat.os}/{plat.arch}`,
					string.rep("ab", 32) .. "  artifact\n  42\n"
				)
			end
			local declared = module.pnpm_toolchain(VERSION, { default = true, lockfile = "@workspace/locks/pnpm.lock" })
			local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
			assert(result.path == "locks/pnpm.lock", result.path)
		end)
	end),

	core.test.case("pnpm store is seeded once and has absolute settings", function()
		host_test(function(host)
			local cache = module.store_tool()
			assert(cache == module.store_tool())
			local function resolve()
				return core.test.resolve(core.task({
					inputs = { cache = cache },
					outputs = { value = core.output.value() },
					run = function(exec, input)
						return { value = module.store_env(exec, input.cache) }
					end,
				}).outputs.value)
			end
			assert(resolve().npm_config_store_dir == "/cache/pnpm-store/shared")
			resolve()
			assert(#host.runs == 1)
		end)
		fails(function()
			module.artifact_name(VERSION, { os = "macos", arch = "x86_64" })
		end, "unsupported pnpm toolchain platform")
	end),
}
