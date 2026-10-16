local core = require("@imp/core")
local rust = require("@imp/rules/rust")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local test = require("@imp/rules/workflows/test")
local expansion = require("@imp/rules/rust/workspace_expansion")
local METADATA = [[{"workspace_root":"/sandbox","workspace_members":["a-id","b-id"],"packages":[{"id":"a-id","name":"a","manifest_path":"/sandbox/crates/a/Cargo.toml","targets":[{"name":"a_lib","kind":["lib"]}]},{"id":"b-id","name":"b","manifest_path":"/sandbox/crates/b/Cargo.toml","targets":[{"name":"b_lib","kind":["lib"]}]}]}]]
local function contains(text, part) return string.find(text, part, 1, true) ~= nil end
local function select_value(handle, check)
	core.test.resolve(core.task({ inputs = { selected = handle }, run = function(_exec, input) check(input.selected) end }))
end
local function members()
	return rust.cargo_package({ path = "crates/a", workspace_member = true }), rust.cargo_package({ path = "crates/b", workspace_member = true })
end
local function count(host, display)
	local n = 0
	for _, run in ipairs(host.runs) do if run.display == display then n += 1 end end
	return n
end
local function with_workspace(fn, flags)
	core.test.with_fake_goal_flags(flags or {}, function()
		core.test.with_fake_toolchain_host(function(host)
			host.set_run_stdout("cargo metadata .", METADATA)
			fn(host)
		end)
	end)
end
return {
	core.test.case("Cargo workspace shares metadata and Clippy and attributes warnings", function()
		with_workspace(function(host)
			host.set_run_stdout("cargo clippy .", [[{"reason":"compiler-message","target":{"src_path":"/sandbox/crates/a/src/lib.rs"},"message":{"level":"warning","rendered":"warning in a"}}]])
			local a, b = members()
			select_value(a[lint.LINT], function(value) assert(not value.ok and contains(value.output, "warning in a")) end)
			select_value(b[lint.LINT], function(value) assert(value.ok) end)
			assert(count(host, "cargo clippy .") == 1 and count(host, "cargo metadata .") == 1)
		end)
	end),
	core.test.case("Cargo workspace reports unattributed Clippy failures", function()
		with_workspace(function(host)
			host.set_run_exit_code("cargo clippy .", 1)
			host.set_run_stderr("cargo clippy .", "workspace failure")
			local a, b = members()
			for _, pkg in ipairs({ a, b }) do select_value(pkg[lint.LINT], function(value) assert(not value.ok and value.output == "workspace failure") end) end
		end)
	end),
	core.test.case("Cargo test binary paths retain manifest identity on Windows", function()
		local bins = expansion.parse_test_binaries([[noise
{"reason":"compiler-artifact","target":{"name":"same","kind":["test"]},"profile":{"test":true},"executable":"C:\\sandbox\\build/rust/root\\debug\\deps\\same.exe","manifest_path":"C:\\sandbox\\crates\\a\\Cargo.toml"}
{"reason":"compiler-artifact","target":{},"profile":{"test":false},"executable":"ignored"}]], "build/rust/root")
		assert(#bins == 1 and bins[1].path == "debug/deps/same.exe" and bins[1].manifest == "C:/sandbox/crates/a/Cargo.toml")
	end),
	core.test.case("Cargo shared tests select each crate and preserve failures", function()
		with_workspace(function(host)
			host.set_run_stdout("cargo test-build .", [[{"reason":"compiler-artifact","target":{"name":"a_test","kind":["test"]},"profile":{"test":true},"executable":"/sandbox/build/rust/root/debug/deps/a_test","manifest_path":"/sandbox/crates/a/Cargo.toml"}
{"reason":"compiler-artifact","target":{"name":"b_test","kind":["test"]},"profile":{"test":true},"executable":"/sandbox/build/rust/root/debug/deps/b_test","manifest_path":"/sandbox/crates/b/Cargo.toml"}]])
			host.set_run_exit_code("test a_test", 1)
			host.set_run_stdout("test a_test", "a failed")
			host.set_run_stderr("cargo doctest .", "   Doc-tests a_lib\n   Doc-tests b_lib\n")
			local a, b = members()
			select_value(a[test.TEST], function(units) assert(#units == 2 and not units[1].ok and contains(units[1].output, "a failed") and units[2].ok) end)
			select_value(b[test.TEST], function(units) assert(#units == 2 and units[1].ok and units[2].ok) end)
			assert(count(host, "cargo test-build .") == 1 and count(host, "cargo doctest .") == 1)
			for _, run in ipairs(host.runs) do if run.display == "test a_test" or run.display == "cargo doctest ." then assert(run.cache == false) end end
		end)
	end),
	core.test.case("Cargo workspace doctests report failed and unreached libraries", function()
		with_workspace(function(host)
			host.set_run_stderr("cargo doctest .", "   Doc-tests a_lib\nerror: test failed, to rerun pass `-p a --doc`\n")
			host.set_run_exit_code("cargo doctest .", 1)
			local a, b = members()
			for _, pkg in ipairs({ a, b }) do select_value(pkg[test.TEST], function(units) assert(#units == 1 and not units[1].ok) end) end
		end)
	end),
	core.test.case("Cargo workspace format check shares the action and attributes paths", function()
		with_workspace(function(host)
			host.set_run_stdout("cargo fmt .", "Diff in /sandbox/crates/a/src/lib.rs:3:\n")
			host.set_run_exit_code("cargo fmt .", 1)
			local a, b = members()
			select_value(a[fmt.FMT], function(value) assert(value.check.failed and value.check.requested and type(value.paths) == "table" and type(value.sources_digest) == "string") end)
			select_value(b[fmt.FMT], function(value) assert(not value.check.failed) end)
			assert(count(host, "cargo fmt .") == 1)
			assert(table.find(host.runs[#host.runs].argv, "--check"))
		end, { check = true })
	end),
	core.test.case("Cargo format write mode publishes an artifact and reports action failures", function()
		with_workspace(function(host)
			host.set_run_exit_code("cargo fmt .", 1)
			local a = members()
			select_value(a[fmt.FMT], function(value) assert(value.check.failed and not value.check.requested and type(value.formatted) == "userdata") end)
			assert(not table.find(host.runs[#host.runs].argv, "--check"))
		end)
	end),
}
