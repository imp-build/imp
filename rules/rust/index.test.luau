local core = require("@imp/core")
local rust = require("@imp/rules/rust")
local toolchain = require("@imp/rules/rust/toolchain")
local codegen = require("@imp/rules/imp/codegen")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local test = require("@imp/rules/workflows/test")
local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end
local function resolve(handle, check)
	return core.test.resolve(core.task({
		inputs = { selected = handle },
		run = function(exec, input)
			check(input.selected, exec)
		end,
	}))
end
local function generated(path)
	return codegen.codegen({
		tools = { sh = core.native_tool("sh") },
		output_paths = { path },
		argv = function()
			return { "sh", "-c", "true" }
		end,
	})
end
return {
	core.test.case("Cargo libraries have test format and lint handles without binary roots", function()
		local pkg = rust.cargo_package({ path = "rules/rust/testdata/cargo" })
		assert(
			type(pkg[test.TEST].unit) == "userdata"
				and type(pkg[test.TEST].doctests) == "userdata"
				and type(pkg[fmt.FMT]) == "userdata"
				and type(pkg[lint.LINT]) == "userdata"
		)
		assert(pkg[build.BUILD] == nil and pkg[package.PACKAGE] == nil)
	end),
	core.test.case("Cargo binary build resolves artifacts through the GCC bridge", function()
		core.test.with_fake_toolchain_host(function(host)
			local pkg = rust.cargo_package({
				path = "rules/rust/example",
				bin = { "hello", "other" },
				release = true,
				cargo_args = { "--offline" },
			})
			core.test.resolve(core.task({
				inputs = { server = pkg[build.BUILD].hello, worker = pkg[build.BUILD].other },
				run = function(_exec, input)
					assert(type(input.server) == "userdata" and type(input.worker) == "userdata")
				end,
			}))
			local builds = 0
			for _, action in ipairs(host.runs) do
				if action.display == "cargo build rules/rust/example" then
					builds += 1
				end
			end
			assert(builds == 1)
			local action = host.runs[#host.runs]
			assert(action.outputs.hello == "build/rust/rules_rust_example/release/hello")
			assert(action.env.CC and contains(action.env.CC, "/cache/gcc-toolchains/"))
			assert(table.find(action.argv, "--release") and table.find(action.argv, "--offline"))
			assert(table.find(action.tools, "dirname") and table.find(action.tools, "sh"))
		end)
	end),
	core.test.case("Cargo packaging returns one file or a directory of named binaries", function()
		core.test.with_fake_toolchain_host(function(host)
			local single = rust.cargo_package({ path = "rules/rust/example", bin = "hello" })
			resolve(single[package.PACKAGE], function(artifact, exec)
				assert(contains(exec.path(artifact), "/hello"))
			end)
			local multiple = rust.cargo_package({ path = "rules/rust/example", bin = { "hello", "other" } })
			resolve(multiple[package.PACKAGE], function(artifact, exec)
				assert(contains(exec.path(artifact), "-package"))
			end)
			local bundled = host.runs[#host.runs]
			assert(bundled.input_count == 2 and table.find(bundled.tools, "cp") and table.find(bundled.tools, "mkdir"))
		end)
	end),
	core.test.case("Cargo custom link driver mold and Kache use declared graph tools", function()
		core.test.with_fake_toolchain_host(function(host)
			local gcc = require("@imp/rules/c/gcc")
			local mold = require("@imp/rules/c/mold")
			local kache = require("@imp/rules/rust/kache")
			local declared = toolchain.rust_toolchain("1.98.1", {
				link_driver = gcc.graph_toolchain(),
				linker = mold.graph_toolchain(),
				kache = kache.kache_toolchain("0.22.0", { cache_size = "8GiB" }),
			})
			local pkg = rust.cargo_package({ path = "rules/rust/example", bin = "hello", toolchain = declared })
			resolve(pkg[build.BUILD].hello, function() end)
			local action = host.runs[#host.runs]
			assert(action.env.KACHE_MAX_SIZE == "8GiB" and action.env.KACHE_LOCAL_ONLY == "1")
			assert(
				contains(action.env.RUSTUP_HOME, "/cache/rustup-home/") and contains(action.env.PATH, "mold-toolchains")
			)
			assert(contains(action.argv[3], "--remap-path-prefix") and #host.workers == 1)
		end)
	end),
	core.test.case("Cargo generated paths normalize codegen and package-relative inputs", function()
		local result = generated("rules/rust/example/src/generated.rs")
		local pkg = rust.cargo_package({
			path = "rules/rust/example",
			generated_srcs = { result, { artifact = result.files[result.paths[1]], path = "src/generated.rs" } },
		})
		assert(#pkg.spec.generated_srcs == 1 and pkg.spec.generated_srcs[1].expected_path == result.paths[1])
		local ok, err = pcall(rust.cargo_package, {
			path = "rules/rust/example",
			generated_srcs = {
				result,
				{ artifact = generated("elsewhere.rs").files["elsewhere.rs"], path = "src/generated.rs" },
			},
		})
		assert(not ok and contains(tostring(err), "different generated sources"))
	end),
	core.test.case("Cargo builds stage generated inputs and validate their paths", function()
		core.test.with_fake_toolchain_host(function(host)
			local result = generated("rules/rust/example/src/generated.rs")
			local pkg = rust.cargo_package({ path = "rules/rust/example", bin = "hello", generated_srcs = { result } })
			resolve(pkg[build.BUILD].hello, function() end)
			assert(host.runs[#host.runs].input_count == 2)
			local bad = rust.cargo_package({
				path = "rules/rust/example",
				bin = "hello",
				generated_srcs = { { artifact = result.files[result.paths[1]], path = "src/wrong.rs" } },
			})
			assert(not pcall(resolve, bad[build.BUILD].hello, function() end))
		end)
	end),
	core.test.case("Cargo sibling generated inputs are collected after declarations", function()
		core.test.with_fake_toolchain_host(function(host)
			local a = rust.cargo_package({ path = "crates/a", bin = "a", workspace_member = true })
			rust.cargo_package({
				path = "crates/b",
				workspace_member = true,
				generated_srcs = { generated("crates/b/src/generated.rs") },
			})
			resolve(a[build.BUILD].a, function() end)
			assert(host.runs[#host.runs].input_count == 2)
		end)
	end),
	core.test.case("Cargo Windows build leaves MSVC linker selection to rustc", function()
		core.test.with_fake_toolchain_host({ os = "windows", arch = "x86_64" }, function(host)
			toolchain.rust_toolchain("1.98.1", { default = true })
			local pkg = rust.cargo_package({ path = "rules/rust/example", bin = "hello" })
			resolve(pkg[build.BUILD].hello, function(result)
				assert(type(result) == "userdata")
			end)
			assert(string.sub(host.runs[#host.runs].outputs.hello, -9) == "hello.exe")
			assert(host.runs[#host.runs].env.CC == nil)
		end)
	end),
}
