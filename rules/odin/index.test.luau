local core = require("@imp/core")
local odin = require("@imp/rules/odin")
local graph = require("@imp/rules/odin/graph")
local build = require("@imp/rules/workflows/build")
local lint = require("@imp/rules/workflows/lint")
local package = require("@imp/rules/workflows/package")
local run = require("@imp/rules/workflows/run")
local test = require("@imp/rules/workflows/test")
local codegen = require("@imp/rules/imp/codegen")
local generator = require("@imp/rules/odin/generate_build")
local ROOT = "rules/odin/example"
local function contains(text, part)
	return string.find(tostring(text), part, 1, true) ~= nil
end
local function fails(fn, expected)
	local ok, err = pcall(fn)
	assert(not ok, "expected failure")
	assert(contains(err, expected), tostring(err))
end
local function fake(fn, platform)
	core.test.with_fake_toolchain_host(platform or { os = "linux", arch = "x86_64" }, function(host)
		host.set_run_stdout(
			"tree-sitter analyze Odin sources",
			[=[{"files": {"rules/odin/example/main.odin": {"imports": ["core:fmt"], "hasMainEntrypoint": true}, "rules/odin/example/split/split.odin": {"imports": [], "hasMainEntrypoint": false}, "rules/odin/example/split/split_test.odin": {"imports": ["core:testing"], "hasMainEntrypoint": false}, "rules/odin/example/staleness/pkg_a/pkg_a.odin": {"imports": [], "hasMainEntrypoint": false}, "rules/odin/example/staleness/pkg_b/pkg_b.odin": {"imports": ["../pkg_a"], "hasMainEntrypoint": true}, "rules/odin/example/staleness/pkg_b/scanner_fixture.odin": {"imports": [], "hasMainEntrypoint": false}, "rules/odin/example/collection/app/main.odin": {"imports": ["lib:greet"], "hasMainEntrypoint": true}, "rules/odin/example/collection/vendor/greet/greet.odin": {"imports": ["lib:util"], "hasMainEntrypoint": false}, "rules/odin/example/collection/vendor/util/util.odin": {"imports": [], "hasMainEntrypoint": false}}}]=]
		)
		fn(host)
	end)
end
local function resolve(handle)
	return core.test.resolve(core.task({
		inputs = { value = handle },
		outputs = { value = core.output.value() },
		run = function(exec, input)
			return { value = if type(input.value) == "userdata" then exec.path(input.value) else input.value }
		end,
	}).outputs.value)
end
local function action(host, display)
	for _, value in ipairs(host.runs) do
		if value.display == display then
			return value
		end
	end
	error("missing action " .. display)
end
local function pkg(path, options)
	options = options or {}
	options.path = path or ROOT
	options.base = "."
	return odin.odin_package(options)
end
return {
	core.test.case("packages expose frozen workflow roots", function()
		local value = pkg()
		assert(table.isfrozen(value) and type(value.sources) == "userdata")
		for _, key in ipairs({ build.BUILD, lint.LINT, package.PACKAGE, run.RUN }) do
			assert(type(value[key]) == "userdata")
		end
		assert(value[test.TEST] == nil)
		local tested = odin.odin_test_package({ base = ".", path = ROOT .. "/split" })
		assert(type(tested[test.TEST]) == "userdata" and tested[run.RUN] == nil)
	end),
	core.test.case("builds and tests use distinct actions with a bounded thread budget", function()
		fake(function(host)
			local lib = pkg(ROOT .. "/split")
			local tested = odin.odin_test_package({ base = ".", path = ROOT .. "/split", deps = { lib } })
			local units = resolve(tested[test.TEST])
			assert(#units == 1 and units[1].ok)
			local value = action(host, "odin test " .. ROOT .. "/split")
			assert(
				value.argv[2] == "test"
					and table.find(value.argv, "-thread-count:4")
					and table.find(value.argv, "-define:ODIN_TEST_THREADS=4")
			)
			assert(value.input_count == 2)
			resolve(tested[build.BUILD])
			assert(table.find(action(host, "odin build " .. ROOT .. "/split").argv, "-build-mode:lib"))
		end)
	end),
	core.test.case("test and lint failures retain diagnostics", function()
		fake(function(host)
			host.set_run_exit_code("odin test " .. ROOT .. "/split", 1)
			host.set_run_stderr("odin test " .. ROOT .. "/split", "assertion failed")
			local value = odin.odin_test_package({ base = ".", path = ROOT .. "/split", srcs = { "*.odin" } })
			local units = resolve(value[test.TEST])
			assert(not units[1].ok and contains(units[1].output, "assertion failed"))
			host.set_run_exit_code("odin check -vet " .. ROOT .. "/split", 1)
			local result = resolve(value[lint.LINT])
			assert(not result.ok and not result.fix_applied)
			local argv = action(host, "odin check -vet " .. ROOT .. "/split").argv
			assert(table.find(argv, "-no-entry-point") and not table.find(argv, "-debug"))
		end)
	end),
	core.test.case("source closure reaches a later declared package and its resources", function()
		fake(function(host)
			local consumer = pkg(ROOT .. "/staleness/pkg_b")
			pkg(ROOT .. "/staleness/pkg_a", { deps = { core.files({ root = ROOT, include = { "main.odin" } }) } })
			resolve(consumer[build.BUILD])
			assert(action(host, "odin build " .. ROOT .. "/staleness/pkg_b").input_count == 3)
		end)
	end),
	core.test.case("collection closure follows undeclared transitive imports", function()
		fake(function(host)
			local value = pkg(ROOT .. "/collection/app", { collections = { lib = ROOT .. "/collection/vendor" } })
			resolve(value[build.BUILD])
			local build_action = action(host, "odin build " .. ROOT .. "/collection/app")
			assert(
				build_action.input_count == 3
					and table.find(build_action.argv, "-collection:lib=" .. ROOT .. "/collection/vendor")
			)
		end)
	end),
	core.test.case("Windows actions retain explicit lld and CRT settings", function()
		fake(function(host)
			local gcc = require("@imp/rules/c/gcc")
			local tools = require("@imp/rules/odin/toolchain")
			gcc.gcc_toolchain("16.2.0posix-14.0.0-ucrt-r1", { default = true })
			local provider = tools.odin_toolchain("dev-2026-03", { lld_on_windows = true, mingw_crt = true })
			local value = pkg(ROOT, { toolchain = provider })
			resolve(value[build.BUILD])
			local build_action = action(host, "odin build " .. ROOT)
			assert(string.match(build_action.argv[1], "odin%.exe$"))
			assert(
				table.find(build_action.argv, "-linker:lld")
					and table.find(build_action.argv, "-no-crt")
					and table.find(build_action.argv, "-out:output.exe")
			)
			local flags = table.concat(build_action.argv, " ")
			assert(contains(flags, "-extra-linker-flags:/force:multiple") and contains(flags, "libucrt.a"))
		end, { os = "windows", arch = "x86_64" })
	end),
	core.test.case("macOS actions link with the host clang instead of gcc", function()
		fake(function(host)
			local tools = require("@imp/rules/odin/toolchain")
			local provider = tools.odin_toolchain("dev-2026-03")
			local value = pkg(ROOT, { toolchain = provider, unsafe_system_paths = true })
			resolve(value[build.BUILD])
			local build_action = action(host, "odin build " .. ROOT)
			assert(table.find(build_action.tools, "clang"), table.concat(build_action.tools, " "))
			assert(build_action.env.PATH == nil, build_action.env.PATH)
		end, { os = "macos", arch = "aarch64" })
	end),
	core.test.case("unsafe system paths select the explicit GCC bypass aliases", function()
		fake(function(host)
			local value = pkg(ROOT, { unsafe_system_paths = true })
			resolve(value[build.BUILD])
			assert(contains(action(host, "odin build " .. ROOT).env.PATH, "/bin-unsafe-paths"))
		end)
	end),
	core.test.case("native dependency records deduplicate resources and preserve link order", function()
		local archive = core.files({ root = ROOT, include = { "main.odin" } })
		local result = graph.resources({
			{
				generated = {},
				deps = {
					{
						transitive_archives = { archive, archive },
						transitive_shared_libs = { archive },
						transitive_linkopts = { "-la", "-lb", "-la" },
					},
				},
			},
		})
		assert(#result.files == 1 and #result.shared == 1 and table.concat(result.linkopts, " ") == "-la -lb")
		fails(function()
			graph.resources({ { generated = {}, path = ".", deps = { {} } } })
		end, "unrecognized shape")
	end),
	core.test.case("defines sort, override profile values, and reject package conflicts", function()
		assert(table.concat(graph.define_args({ Z = "2", A = "true" }), " ") == "-define:A=true -define:Z=2")
		fails(function()
			graph.define_args({ A = true })
		end, "string value")
		fails(function()
			graph.define_args({ ["bad-name"] = "1" })
		end, "invalid Odin define")
		assert(graph.merged_defines({ { defines = { A = "target" } } }, { defines = { A = "profile" } }).A == "target")
		fails(function()
			graph.merged_defines({ { defines = { A = "1" } }, { defines = { A = "2" } } }, {})
		end, "conflicting define")
	end),
	core.test.case("generated sources stage through imported packages and reject duplicate paths", function()
		fake(function(host)
			local generated =
				codegen.stamp_file({ output = ROOT .. "/staleness/pkg_a/value.odin", text = "package pkg_a" })
			local consumer = pkg(ROOT .. "/staleness/pkg_b")
			pkg(ROOT .. "/staleness/pkg_a", { generated_srcs = { { artifact = generated.file, path = "value.odin" } } })
			resolve(consumer[build.BUILD])
			assert(action(host, "odin build " .. ROOT .. "/staleness/pkg_b").input_count == 3)
			fails(function()
				pkg(ROOT, { generated_srcs = { {} } })
			end, "generated_srcs")
			local second = codegen.stamp_file({ output = ROOT .. "/staleness/pkg_a/value.odin", text = "other" })
			fails(function()
				graph.resources({
					{
						deps = {},
						generated = {
							{ artifact = generated.file, expected_path = "same.odin" },
							{ artifact = second.file, expected_path = "same.odin" },
						},
					},
				})
			end, "two different")
		end)
	end),
	core.test.case("runtime library paths and Windows test outputs use staged directories", function()
		local paths = { "build/a/x.dll", "build/a/y.dll", "build/b/z.dll" }
		assert(graph.library_env(paths, { os = "linux" }).LD_LIBRARY_PATH == "build/a:build/b")
		assert(next(graph.library_env(paths, { os = "windows" })) == nil)
		fails(function()
			graph.test_out_args(paths, { os = "windows" })
		end, "more than one directory")
		assert(graph.test_out_args({ paths[1], paths[2] }, { os = "windows" })[1] == "-out:build/a/output.exe")
	end),
	core.test.case("workspace escapes and multiple source directories fail clearly", function()
		fails(function()
			graph.join(".", "../outside")
		end, "escapes")
		fails(function()
			graph.analyze({ path = "." }, {}, { "a/a.odin", "b/b.odin" })
		end, "multiple package")
	end),
	core.test.case("BUILD generation returns nothing for an existing package", function()
		pkg(ROOT .. "/staleness/pkg_a")
		assert(next(generator.generate_build({ root = ROOT .. "/staleness/pkg_a" })) == nil)
	end),
}
