local core = require("@imp/core")
local rust = require("@imp/rules/rust/toolchain")
local locks = require("@imp/rules/workflows/lockfiles")
local function contains(text, part) return string.find(text, part, 1, true) ~= nil end
local function resolve_env(kache)
	local graph = rust.graph_toolchain()
	return core.test.resolve(core.task({
		inputs = { tool = graph.tool, cargo = graph.cargo_home_tool }, outputs = { value = core.output.value() },
		run = function(exec, input) return { value = rust.graph_tool_env(exec, input.tool, input.cargo, graph.toolchain_id, graph.version, kache) } end,
	}).outputs.value)
end
return {
 core.test.case("Rust custom lockfile supplies the download checksum", function()
  core.test.with_fake_toolchain_host(function(host)
   rust.rust_toolchain("1.98.1", { default = true, lockfile = "@imp/rules/rust/testdata/rust-custom.json" })
   resolve_env(false)
   assert(contains(table.concat(host.runs[1].argv, " "), string.rep("ab", 32)))
  end)
 end),
 core.test.case("Rust lockfile root uses the declared workspace address", function()
  core.test.with_fake_run(function(host)
   for _, plat in ipairs(rust.supported_platforms()) do host.set_run_stdout(`lock rust 1.98.1 {plat.os}/{plat.arch}`, string.rep("ab", 32) .. "  artifact\n  42\n") end
   local declared = rust.rust_toolchain("1.98.1", { lockfile = "@workspace/locks/rust.lock" })
   local result = core.test.resolve(declared[locks.GEN_LOCKFILES])
   assert(result.path == "locks/rust.lock")
  end)
 end),
	core.test.case("Rust declares the pinned default and lockfile goal", function()
		assert(rust.default_version() == "1.98.1")
		assert(type(rust.default_toolchain()[locks.GEN_LOCKFILES]) == "userdata")
	end),
	core.test.case("Rust rejects channels and incomplete pins", function()
		for _, version in ipairs({ "stable", "nightly", "1.98", "v1.98.1" }) do
			local ok, err = pcall(rust.rust_toolchain, version)
			assert(not ok and contains(tostring(err), "exact version"))
		end
	end),
	core.test.case("Rust has no implicit version after reset", function()
		rust.reset_for_test()
		assert(not pcall(rust.graph_toolchain))
	end),
	core.test.case("Rust platform filenames and triples retain the installer pin", function()
		for _, plat in ipairs(rust.supported_platforms()) do
			local url = rust.download_url("1.98.1", plat)
			assert(contains(url, "/archive/1.27.1/"))
			assert(contains(rust.toolchain_id("1.98.1", plat), "1.98.1-"))
			assert(rust.artifact_name("1.98.1", plat) == (if plat.os == "windows" then "rustup-init.exe" else "rustup-init"))
		end
		assert(not pcall(rust.download_url, "1.98.1", { os = "linux", arch = "bad" }))
	end),
	core.test.case("Rust declaration does not run actions", function()
		core.test.with_fake_toolchain_host(function(host)
			rust.rust_toolchain("1.98.1", { default = true })
			assert(#host.runs == 0)
		end)
	end),
	core.test.case("Rust installs both homes and uses atomic mounts", function()
		core.test.with_fake_toolchain_host(function(host)
			rust.rust_toolchain("1.98.1", { default = true })
			local value = resolve_env(false)
			assert(value.env.RUSTUP_HOME == ".imp/tools/rustup-home" and value.env.CARGO_HOME == ".imp/tools/cargo-home")
			assert(#host.runs == 2)
			local install = host.runs[2]
			assert(install.outputs.rustup_home == "rustup-home" and install.outputs.cargo_home == "cargo-home")
			assert(contains(install.argv[3], "--component rustfmt --component clippy"))
		end)
	end),
	core.test.case("Rust Kache environment uses stable absolute homes", function()
		core.test.with_fake_toolchain_host(function()
			rust.rust_toolchain("1.98.1", { default = true })
			local value = resolve_env(true)
			assert(value.env.RUSTUP_HOME == "/cache/rustup-home/1.98.1/linux-x86_64")
			assert(contains(value.env.PATH, "/toolchains/1.98.1-x86_64-unknown-linux-gnu/bin:"))
		end)
	end),
	core.test.case("Rust rejects malformed and missing custom lockfiles", function()
		assert(not pcall(rust.rust_toolchain, "1.98.1", { lockfile = "locks/rust.lock" }))
		core.test.with_fake_toolchain_host(function()
			rust.rust_toolchain("1.98.1", { default = true, lockfile = "@workspace/missing-rust.lock" })
			local ok, err = pcall(resolve_env, false)
			assert(not ok and contains(tostring(err), "missing-rust.lock"))
		end)
	end),
}
