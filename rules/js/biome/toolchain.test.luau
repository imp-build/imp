local core = require("@imp/core")
local locks = require("@imp/rules/workflows/lockfiles")
local module = require("@imp/rules/js/biome")
local VERSION = "2.5.4"
local CUSTOM = "@imp/rules/js/biome/testdata/locked.json"
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
			return { value = module.biome_bin(exec, input.tool) }
		end,
	}).outputs.value)
end
return {
	core.test.case("biome declares the pinned default", function()
		assert(module.default_version() == VERSION)
	end),
	core.test.case("biome requires a default or a version", function()
		host_test(function()
			fails(module.graph_toolchain, "no biome toolchain version specified")
		end)
	end),
	core.test.case("biome graph construction does not execute acquisition", function()
		host_test(function(host)
			local declared = module.biome_toolchain(VERSION, { default = true })
			assert(type(declared[locks.GEN_LOCKFILES]) == "userdata")
			assert(declared.lockfile == "@imp/rules/js/biome/biome-toolchain.lock")
			assert(type(module.graph_toolchain().tool) == "userdata")
			assert(table.isfrozen(module.graph_toolchain()))
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("biome verifies a custom lock and publishes the executable cache", function()
		host_test(function(host)
			module.biome_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/biome-toolchains/" .. VERSION .. "/linux-x86_64/biome")
			assert(#host.runs == 2)
			assert(table.find(host.runs[1].argv, "https://locked.example/biome"))
			assert(table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
			assert(contains(host.runs[2].argv[3], "chmod +x"))
			assert(table.find(host.runs[2].argv, "biome-toolchain"))
		end)
	end),
	core.test.case("biome uses the shipped lock by default", function()
		host_test(function(host)
			module.biome_toolchain(VERSION, { default = true })
			install()
			assert(not table.find(host.runs[1].argv, "deadbeef"))
			assert(contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("biome reports missing, unlocked, and malformed locks", function()
		host_test(function()
			fails(function()
				module.biome_toolchain(VERSION, { lockfile = "relative.lock" })
			end, "must start with")
			module.biome_toolchain(VERSION, { default = true, lockfile = "@workspace/missing.lock" })
			fails(install, "no lockfile found")
		end)
		host_test(function()
			module.biome_toolchain("99.0.0", { default = true })
			fails(install, "gen-lockfiles")
		end)
	end),
	core.test.case("biome permits an unverified version only when requested", function()
		host_test(function(host)
			module.biome_toolchain("99.0.0", { default = true, unverified = true })
			install()
			assert(not contains(host.runs[1].argv[3], "sha256sum -c"))
		end)
	end),
	core.test.case("biome preserves platform mappings and Windows installation", function()
		assert(#module.supported_platforms() == 6)
		local names = {
			"biome-linux-x64",
			"biome-linux-arm64",
			"biome-darwin-x64",
			"biome-darwin-arm64",
			"biome-win32-x64.exe",
			"biome-win32-arm64.exe",
		}
		for i, plat in ipairs(module.supported_platforms()) do
			assert(module.artifact_name(VERSION, plat) == names[i])
			assert(
				module.download_url(VERSION, plat)
					== "https://github.com/biomejs/biome/releases/download/@biomejs/biome@"
						.. VERSION
						.. "/"
						.. names[i]
			)
		end
		assert(module.cache_key(VERSION, { os = "linux", arch = "aarch64" }) == VERSION .. "/linux-aarch64")
		fails(function()
			module.artifact_name(VERSION, { os = "linux", arch = "riscv64" })
		end, "unsupported biome toolchain platform")
		host_test(function(host)
			module.biome_toolchain(VERSION, { default = true, lockfile = CUSTOM })
			assert(install() == "/cache/biome-toolchains/" .. VERSION .. "/windows-x86_64/biome.exe")
			assert(not contains(host.runs[2].argv[3], "chmod"))
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("biome generates the selected workspace lockfile", function()
		core.test.with_fake_run(function(host)
			module.reset_for_test()
			for _, plat in ipairs(module.supported_platforms()) do
				host.set_run_stdout(
					`lock biome-toolchain {VERSION} {plat.os}/{plat.arch}`,
					string.rep("ab", 32) .. "  artifact\n  42\n"
				)
			end
			local declared =
				module.biome_toolchain(VERSION, { default = true, lockfile = "@workspace/locks/biome.lock" })
			local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
			assert(result.path == "locks/biome.lock", result.path)
		end)
	end),

	core.test.case("local artifact and path inputs install without downloads", function()
		host_test(function(host)
			local function source(contents)
				return core.task({
					outputs = { file = core.output.artifact() },
					run = function(exec)
						return { file = exec.file({ path = "biome-local", contents = contents }) }
					end,
				}).outputs.file
			end
			local first = module.install_biome_toolchain("local", source("first"), { default = true })
			assert(table.isfrozen(first) and module.default_version() == "local")
			local first_path = install()
			assert(#host.runs == 2)
			assert(contains(first_path, "/biome-local-toolchains/local/linux-x86_64/"))
			module.install_biome_toolchain("local", core.path(source("second")), { default = true })
			assert(contains(install(), "/biome-local-toolchains/"))
			assert(#host.runs == 4)
			assert(not pcall(module.install_biome_toolchain, "local", "/tmp/biome"))
		end)
	end),
}
