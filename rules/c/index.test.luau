-- Tests of `@imp/rules/c`.
--
-- Each case uses a gcc provider around a native tool handle, so that no case
-- downloads a toolchain. The toolchain host fake records each action in
-- place of a run.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local run_workflow = require("@imp/rules/workflows/run")
local test_workflow = require("@imp/rules/workflows/test")
local codegen = require("@imp/rules/imp/codegen")
local gcc = require("@imp/rules/c/gcc")
local zig = require("@imp/rules/c/zig")
local c = require("@imp/rules/c")

local BUILD = build.BUILD
local PACKAGE = package.PACKAGE
local RUN = run_workflow.RUN
local TEST = test_workflow.TEST

local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }
local MIXED = "rules/c/testdata/mixed_sources"

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function has(list, value)
	for _, item in ipairs(list) do
		if item == value then
			return true
		end
	end
	return false
end

local function same(actual, expected)
	assert(#actual == #expected, `expected {#expected} values, got {#actual}`)
	for index, value in ipairs(expected) do
		assert(rawequal(actual[index], value), `value {index} is not the expected value`)
	end
end

local function starts_with(text, prefix)
	return string.sub(text, 1, #prefix) == prefix
end

local function runs_with(host, prefix)
	local found = {}
	for _, run in ipairs(host.runs) do
		if starts_with(run.display, prefix) then
			table.insert(found, run)
		end
	end
	return found
end

local function run_with(host, prefix)
	local found = runs_with(host, prefix)
	assert(#found > 0, `no run has a display that starts with '{prefix}'`)
	return found[1]
end

local function argv_text(run, separator)
	return table.concat(run.argv, separator or " ")
end

--- A gcc provider around a native tool handle, in place of the downloaded
--- toolchain of `gcc.graph_toolchain()`.
local function fake_gcc()
	return gcc.toolchain_record(core.native_tool("gcc-toolchain"), "2025.08-1")
end

--- Run `fn(host)` with the toolchain host fake on `platform` (the default is
--- Linux).
local function with_cc_host(platform, fn)
	if fn == nil then
		fn = platform
		platform = LINUX
	end
	return core.test.with_fake_toolchain_host(platform, fn)
end

local function library(options)
	options = options or {}
	options.path = options.path or MIXED
	options.toolchain = options.toolchain or fake_gcc()
	return c.cc_library(options)
end

local function binary(options)
	options = options or {}
	options.path = options.path or MIXED
	options.toolchain = options.toolchain or fake_gcc()
	return c.cc_binary(options)
end

local function c_codegen(output_path)
	return codegen.codegen({
		tools = { sh = core.native_tool("sh") },
		output_paths = { output_path },
		argv = function()
			return { "sh", "-c", "true" }
		end,
	})
end

return {
	core.test.suite("cc_library and cc_binary", {
		core.test.case("cc_library has BUILD and PACKAGE slots and transitive lists", function()
			with_cc_host(function()
				local lib = library()
				assert(type(lib[BUILD]) == "userdata")
				assert(rawequal(lib[PACKAGE], lib.archive))
				same(lib.transitive_archives, { lib.archive })
				assert(#lib.transitive_include_dirs == 1 and lib.transitive_include_dirs[1] == MIXED)
				assert(#lib.transitive_hdrs == 1)
				assert(type(lib.transitive_hdrs[1]) == "userdata")
			end)
		end),

		core.test.case("a shared library is in the shared list and never in the archive list", function()
			with_cc_host(function()
				local static_lib = library()
				same(static_lib.transitive_archives, { static_lib.archive })
				same(static_lib.transitive_shared_libs, {})

				local shared_lib = library({ shared = true })
				same(shared_lib.transitive_archives, {})
				same(shared_lib.transitive_shared_libs, { shared_lib.archive })
			end)
		end),

		core.test.case("a shared library has a lib-prefixed filename and soname", function()
			with_cc_host(function(host)
				local shared_lib = library({ shared = true })
				core.test.resolve(shared_lib[BUILD])
				local link = run_with(host, "cc shared-link ")
				local expected = "librules_c_testdata_mixed_sources.so"
				assert(link.display == `cc shared-link build/c/{expected}`, link.display)
				-- Without -Wl,-soname, the DT_NEEDED entry of a consumer has the
				-- link-line path, and the loader does not search for a name with
				-- a slash.
				assert(contains(argv_text(link), `-Wl,-soname,{expected}`))
			end)
		end),

		core.test.case("a shared library writes an import library on Windows", function()
			with_cc_host(WINDOWS, function(host)
				local shared_lib = library({ shared = true })
				local static_lib = library({ output_name = "static_only" })
				assert(#shared_lib.transitive_import_libs == 1)
				same(static_lib.transitive_import_libs, {})
				core.test.resolve(shared_lib[BUILD])
				local link = run_with(host, "cc shared-link ")
				assert(link.display == "cc shared-link build/c/rules_c_testdata_mixed_sources.dll", link.display)
				assert(contains(argv_text(link), "-Wl,--out-implib,build/c/rules_c_testdata_mixed_sources.lib"))
				assert(link.outputs.import_lib == "build/c/rules_c_testdata_mixed_sources.lib")
			end)
		end),

		core.test.case("a shared library writes no import library on Linux", function()
			with_cc_host(function(host)
				local shared_lib = library({ shared = true })
				same(shared_lib.transitive_import_libs, {})
				core.test.resolve(shared_lib[BUILD])
				local link = run_with(host, "cc shared-link ")
				assert(not contains(argv_text(link), "--out-implib"))
				assert(link.outputs.import_lib == nil)
			end)
		end),

		core.test.case("a Windows binary has the .exe suffix", function()
			with_cc_host(WINDOWS, function(host)
				core.test.resolve(binary()[BUILD])
				local link = run_with(host, "cc link ")
				assert(link.display == "cc link build/c/rules_c_testdata_mixed_sources.exe", link.display)
			end)
		end),

		core.test.case("a static library and a binary get no soname and keep their names", function()
			with_cc_host(function(host)
				local lib = library()
				core.test.resolve(binary({ deps = { lib } })[BUILD])
				for _, run in ipairs(host.runs) do
					assert(not contains(argv_text(run), "-Wl,-soname"), run.display)
				end
				local archive = run_with(host, "cc archive ")
				assert(archive.display == "cc archive build/c/rules_c_testdata_mixed_sources.a", archive.display)
			end)
		end),

		core.test.case("output_name separates artifacts and object paths in one directory", function()
			with_cc_host(function(host)
				local first = library({ output_name = "first" })
				local second = library({ output_name = "second" })
				-- Two targets with the same path are two different tasks.
				assert(not rawequal(first.archive, second.archive))
				core.test.resolve(first[BUILD])
				core.test.resolve(second[BUILD])
				local archives = {}
				for _, run in ipairs(runs_with(host, "cc archive ")) do
					table.insert(archives, run.display)
				end
				assert(has(archives, "cc archive build/c/first.a"))
				assert(has(archives, "cc archive build/c/second.a"))
				local first_object, second_object = false, false
				for _, run in ipairs(runs_with(host, "cc compile ")) do
					first_object = first_object or contains(run.display, "obj/first/")
					second_object = second_object or contains(run.display, "obj/second/")
				end
				assert(first_object and second_object)
			end)
		end),

		core.test.case("output_name changes a shared library soname and a bundled executable name", function()
			with_cc_host(function(host)
				local shared_dep = library({ output_name = "runtime", shared = true })
				core.test.resolve(binary({ output_name = "app", deps = { shared_dep } })[BUILD])
				local shared_link = run_with(host, "cc shared-link ")
				assert(shared_link.display == "cc shared-link build/c/libruntime.so", shared_link.display)
				assert(contains(argv_text(shared_link), "-Wl,-soname,libruntime.so"))
				assert(run_with(host, "cc link ").display == "cc link build/c/app")
				local bundle = run_with(host, "cc bundle ")
				assert(has(bundle.argv, "build/c/app"))
				assert(has(bundle.argv, "build/c/libruntime.so"))
				assert(has(bundle.argv, "build/c/rules_c_testdata_mixed_sources.d/"))
			end)
		end),

		core.test.case("output_name rejects stems that are not portable", function()
			with_cc_host(function()
				for _, name in ipairs({ "../app", "", "app.exe", "app.A", "lib.so", "..", "a b", 7 }) do
					local message = error_text(binary, { output_name = name })
					assert(
						contains(message, "C/C++ output_name must be a non-empty portable filename stem"),
						message
					)
				end
			end)
		end),

		core.test.case("both transitive lists go through a dependent library", function()
			with_cc_host(function()
				local static_dep = library()
				local shared_dep = library({ shared = true })
				local lib = library({ deps = { static_dep, shared_dep } })
				same(lib.transitive_archives, { lib.archive, static_dep.archive })
				same(lib.transitive_shared_libs, { shared_dep.archive })
			end)
		end),

		core.test.case("a dependency without transitive_shared_libs still builds", function()
			with_cc_host(function()
				local lib = library({ deps = { { transitive_archives = {}, transitive_include_dirs = {} } } })
				same(lib.transitive_shared_libs, {})
				core.test.resolve(lib[BUILD])
			end)
		end),

		core.test.case("the link action mounts the objects and each dependency library", function()
			with_cc_host(function(host)
				local static_dep = library({ output_name = "static_dep" })
				local shared_dep = library({ output_name = "shared_dep", shared = true })
				core.test.resolve(binary({ deps = { static_dep, shared_dep } })[BUILD])
				-- Two objects, one archive, and one shared library.
				assert(run_with(host, "cc link ").input_count == 4)
			end)
		end),

		core.test.case("the include directories of a dependency reach the compile flags after the own directory", function()
			with_cc_host(function(host)
				local lib = library({ path = "rules/c/testdata/dep_lib" })
				core.test.resolve(binary({ path = "rules/c/testdata/dep_consumer", deps = { lib } })[BUILD])
				local consumer = nil
				for _, run in ipairs(runs_with(host, "cc compile ")) do
					if contains(run.display, "dep_consumer") then
						consumer = run
					end
				end
				assert(consumer ~= nil)
				local script = consumer.argv[3]
				local own = string.find(script, "'-Irules/c/testdata/dep_consumer'", 1, true)
				local dep = string.find(script, "'-Irules/c/testdata/dep_lib'", 1, true)
				assert(own ~= nil and dep ~= nil and own < dep, script)
			end)
		end),

		core.test.case("the link action of a shared library mounts its dependency archives", function()
			with_cc_host(function(host)
				local static_dep = library({ output_name = "static_dep" })
				core.test.resolve(library({ output_name = "runtime", shared = true, deps = { static_dep } })[BUILD])
				local link = run_with(host, "cc shared-link ")
				-- Two objects and one archive.
				assert(link.input_count == 3)
				assert(contains(argv_text(link, ""), "build/c/static_dep.a"))
			end)
		end),

		core.test.case("the default toolchain is zig when zig and gcc both have a default", function()
			with_cc_host(function(host)
				core.test.resolve(c.cc_library({ path = MIXED })[BUILD])
				local compiles = runs_with(host, "cc compile ")
				assert(#compiles == 2)
				for _, run in ipairs(compiles) do
					assert(contains(run.argv[3], "zig"), run.argv[3])
				end
			end)
		end),

		core.test.case("a binary has no archive fields of its own", function()
			with_cc_host(function()
				local bin = binary({ deps = { library() } })
				assert(type(bin[BUILD]) == "userdata")
				assert(bin.transitive_archives == nil)
			end)
		end),

		core.test.case("a binary mounts the headers of a dependency in its compile sandbox (#114)", function()
			with_cc_host(function(host)
				core.test.resolve(binary({ path = "rules/c/testdata/dep_consumer", srcs = { "main.c" } })[BUILD])
				local baseline = run_with(host, "cc compile ").input_count
				local before = #host.runs

				local lib = library({ path = "rules/c/testdata/dep_lib" })
				core.test.resolve(binary({ path = "rules/c/testdata/dep_consumer", deps = { lib } })[BUILD])
				local consumer = {}
				for index = before + 1, #host.runs do
					local run = host.runs[index]
					if starts_with(run.display, "cc compile ") and contains(run.display, "dep_consumer") then
						table.insert(consumer, run)
					end
				end
				assert(#consumer == 1, `expected 1 consumer compile, got {#consumer}`)
				-- The header file set of the dependency is one more input.
				assert(consumer[1].input_count == baseline + 1)
			end)
		end),

		core.test.case("each source compiles in its own action (#84)", function()
			with_cc_host(function(host)
				core.test.resolve(library()[BUILD])
				local compiles = runs_with(host, "cc compile ")
				-- mixed_sources has main.c and message.cc.
				assert(#compiles == 2, `expected 2 compile actions, got {#compiles}`)
				for _, run in ipairs(compiles) do
					local _, count = string.gsub(run.argv[3], " %-c ", "")
					assert(count == 1, run.argv[3])
				end
			end)
		end),

		core.test.case("the archive action reads object paths from a chunked response file", function()
			with_cc_host(function(host)
				core.test.resolve(library()[BUILD])
				local archive = run_with(host, "cc archive ")
				-- The script stays small and fixed. The object list is only in
				-- the argv elements after it, which the script writes to the
				-- response file.
				assert(not contains(archive.argv[3], ".o"))
				assert(contains(archive.argv[3], "@"))
				local content = table.concat(archive.argv, "", 6)
				assert(contains(content, ".o"))
			end)
		end),

		core.test.case("the response file content is split into chunks of 4000 bytes", function()
			with_cc_host(function(host)
				local linkopts = {}
				for index = 1, 600 do
					table.insert(linkopts, `-lsome_long_library_name_{index}`)
				end
				core.test.resolve(binary({ linkopts = linkopts })[BUILD])
				local link = run_with(host, "cc link ")
				assert(#link.argv > 6, "expected more than one chunk")
				for index = 6, #link.argv - 1 do
					assert(#link.argv[index] == 4000)
				end
				assert(contains(table.concat(link.argv, "", 6), "-lsome_long_library_name_600"))
			end)
		end),

		core.test.case("each compile action declares one output at its own object path", function()
			with_cc_host(function(host)
				core.test.resolve(library()[BUILD])
				local compiles = runs_with(host, "cc compile ")
				assert(#compiles == 2)
				local paths = {}
				for _, run in ipairs(compiles) do
					local count = 0
					for _ in pairs(run.outputs) do
						count += 1
					end
					assert(count == 1)
					paths[run.outputs.object] = true
				end
				assert(paths["build/c/obj/rules_c_testdata_mixed_sources/rules_c_testdata_mixed_sources_main.c.o"])
				assert(paths["build/c/obj/rules_c_testdata_mixed_sources/rules_c_testdata_mixed_sources_message.cc.o"])
			end)
		end),

		core.test.case("C rules select mode flags and share axis-blind generated sources", function()
			for _, declare in ipairs({ c.cc_library, c.cc_binary, c.cc_test }) do
				with_cc_host(function(host)
					local generated = c_codegen(`{MIXED}/generated/mode.h`)
					local target = declare({
						path = MIXED,
						toolchain = fake_gcc(),
						generated_srcs = { generated },
					})
					for step, mode in ipairs({ "debug", "release", "debug" }) do
						core.test.resolve(core.configured(target[BUILD], { opt = mode }))
						local compiles = runs_with(host, "cc compile ")
						local expected_count = if step == 1 then 2 else 4
						assert(#compiles == expected_count, `expected {expected_count} compiles, got {#compiles}`)
					end
					local compiles = runs_with(host, "cc compile ")
					assert(#compiles == 4)
					for index, run in ipairs(compiles) do
						local flags = run.argv[3]
						local debug = index <= 2
						assert(contains(flags, "'-O0' '-g'") == debug, flags)
						assert(contains(flags, "'-O2' '-DNDEBUG'") == not debug, flags)
					end
					assert(#runs_with(host, "generate ") == 1, "axis-blind generator must run once")
				end)
			end
		end),

		core.test.case("unsafe_system_paths selects the -unsafe-paths compilers and plain ar", function()
			with_cc_host(function(host)
				core.test.resolve(library({ unsafe_system_paths = true })[BUILD])
				local compiles = runs_with(host, "cc compile ")
				assert(#compiles == 2)
				for _, run in ipairs(compiles) do
					assert(
						contains(run.argv[3], "clang-unsafe-paths") or contains(run.argv[3], "c++-unsafe-paths"),
						run.argv[3]
					)
				end
				-- ar is a binutils binary, not a wrapper, so the option does
				-- not change it.
				assert(not contains(run_with(host, "cc archive ").argv[3], "unsafe-paths"))
			end)
		end),

		core.test.case("the transitive_linkopts of a dependency go to the link step, not to the archive step", function()
			with_cc_host(function(host)
				local lib = library()
				local dep = table.clone(lib)
				dep.transitive_linkopts = { "-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1" }
				core.test.resolve(binary({ deps = { dep } })[BUILD])
				local link = argv_text(run_with(host, "cc link "), "")
				assert(contains(link, "-lwebkit2gtk-4.1"))
				assert(contains(link, "-L/usr/lib/x86_64-linux-gnu"))
				for _, run in ipairs(runs_with(host, "cc archive ")) do
					assert(not contains(argv_text(run, ""), "webkit2gtk"))
				end
			end)
		end),

		core.test.case("a shared library of a dependency goes to the link step and never to the archive step", function()
			with_cc_host(function(host)
				local shared_dep = library({ shared = true })
				core.test.resolve(binary({ deps = { shared_dep } })[BUILD])
				local name = "mixed_sources.so"
				assert(contains(argv_text(run_with(host, "cc link "), ""), name))
				for _, run in ipairs(runs_with(host, "cc archive ")) do
					assert(not contains(argv_text(run, ""), name))
				end
			end)
		end),

		core.test.case("a binary with a shared dependency is bundled and links with an $ORIGIN rpath", function()
			with_cc_host(function(host)
				local shared_dep = library({ shared = true })
				core.test.resolve(binary({ deps = { shared_dep } })[BUILD])
				local link = run_with(host, "cc link ")
				assert(link.display == "cc link build/c/rules_c_testdata_mixed_sources", link.display)
				assert(contains(argv_text(link), "-Wl,-rpath,$ORIGIN"))
				assert(not contains(argv_text(link), "cp "))
				local bundle = run_with(host, "cc bundle ")
				assert(bundle.argv[1] == "cp")
				assert(has(bundle.argv, "build/c/rules_c_testdata_mixed_sources"))
				assert(has(bundle.argv, "build/c/librules_c_testdata_mixed_sources.so"))
				assert(has(bundle.argv, "build/c/rules_c_testdata_mixed_sources.d/"))
			end)
		end),

		core.test.case("a binary without a shared dependency is one file without an rpath", function()
			with_cc_host(function(host)
				core.test.resolve(binary({ deps = { library() } })[BUILD])
				local link = run_with(host, "cc link ")
				assert(link.display == "cc link build/c/rules_c_testdata_mixed_sources", link.display)
				assert(not contains(argv_text(link), "-Wl,-rpath"))
				assert(#runs_with(host, "cc bundle ") == 0)
			end)
		end),

		core.test.case("cc_test has a TEST slot and cc_binary has a RUN slot", function()
			with_cc_host(function()
				local bin = binary()
				local suite = c.cc_test({ path = MIXED, toolchain = fake_gcc() })
				assert(bin[RUN] ~= nil)
				assert(suite[TEST] ~= nil)
				assert(suite[RUN] ~= nil)
				-- Nothing publishes a test target.
				assert(suite[PACKAGE] == nil)
			end)
		end),

		core.test.case("cc_test reports the exit code of the executable as one unit", function()
			with_cc_host(function(host)
				host.set_run_exit_code(`cc test {MIXED}`, 3)
				host.set_run_stdout(`cc test {MIXED}`, "assertion failed")
				local suite = c.cc_test({ path = MIXED, toolchain = fake_gcc() })
				local units = core.test.resolve(suite[TEST])
				assert(#units == 1)
				assert(units[1].name == MIXED)
				assert(units[1].ok == false)
				assert(units[1].output == "assertion failed")
				local run = run_with(host, "cc test ")
				assert(run.allow_failure == true)
				assert(run.argv[1] == "build/c/rules_c_testdata_mixed_sources")
			end)
		end),

		core.test.case("cc_test starts a bundled executable from its product directory", function()
			with_cc_host(function(host)
				local shared_dep = library({ shared = true })
				local suite = c.cc_test({ path = MIXED, toolchain = fake_gcc(), deps = { shared_dep } })
				local units = core.test.resolve(suite[TEST])
				assert(units[1].ok == true)
				local run = run_with(host, "cc test ")
				assert(
					run.argv[1] == "build/c/rules_c_testdata_mixed_sources.d/rules_c_testdata_mixed_sources",
					run.argv[1]
				)
			end)
		end),

		core.test.case("cc_library forwards the transitive_linkopts of a dependency, not its own linkopts", function()
			with_cc_host(function()
				local dep = { transitive_archives = {}, transitive_include_dirs = {}, transitive_linkopts = { "-lfoo" } }
				local lib = library({ deps = { dep }, linkopts = { "-lown" } })
				same(lib.transitive_linkopts, { "-lfoo" })
			end)
		end),

		core.test.case("cc_workload_specs lists the declared targets in order", function()
			with_cc_host(function()
				library({ output_name = "first" })
				binary({ output_name = "second" })
				local specs = c.cc_workload_specs()
				assert(#specs == 2)
				assert(specs[1].output_name == "first")
				assert(specs[2].output_name == "second")
				assert(specs[1].path == MIXED)
			end)
		end),

		core.test.case("a path outside the workspace fails", function()
			with_cc_host(function()
				local message = error_text(library, { path = "../outside" })
				assert(contains(message, "C/C++ paths must stay within the workspace"), message)
			end)
		end),

		core.test.case("fails without an explicit toolchain or a declared gcc or zig default", function()
			with_cc_host(function()
				-- gcc and zig declare a default when they load.
				gcc.reset_for_test()
				zig.reset_for_test()
				local message = error_text(c.cc_library, { path = MIXED })
				assert(contains(message, "cc_library()/cc_binary() need an explicit toolchain"), message)
			end)
		end),
	}),

	core.test.suite("generated_srcs", {
		core.test.case("a generated .c file compiles at its declared path", function()
			with_cc_host(function(host)
				local generated = c_codegen(`{MIXED}/generated/extra.c`)
				core.test.resolve(library({ generated_srcs = { generated } })[BUILD])
				local generator = run_with(host, "generate ")
				assert(generator.display == `generate {MIXED}/generated/extra.c`, generator.display)
				local compiled = false
				for _, run in ipairs(runs_with(host, "cc compile ")) do
					compiled = compiled or contains(run.display, "generated_extra.c.o")
				end
				assert(compiled)
				assert(#runs_with(host, "cc compile ") == 3)
			end)
		end),

		core.test.case("a generated .h file is staged and not compiled", function()
			local baseline = with_cc_host(function(host)
				core.test.resolve(library()[BUILD])
				return run_with(host, "cc compile ").input_count
			end)
			with_cc_host(function(host)
				local generated = c_codegen(`{MIXED}/generated/api.h`)
				core.test.resolve(library({ generated_srcs = { generated } })[BUILD])
				local compiles = runs_with(host, "cc compile ")
				assert(#compiles == 2)
				-- The generated header is one more input of each compile.
				assert(compiles[1].input_count == baseline + 1)
			end)
		end),

		core.test.case("a generated file that is not a C source or header fails", function()
			with_cc_host(function()
				local generated = c_codegen(`{MIXED}/generated/notes.txt`)
				local message = error_text(library, { generated_srcs = { generated } })
				assert(contains(message, "neither a C/C++ source nor a header"), message)
			end)
		end),
	}),
}
