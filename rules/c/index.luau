-- The raw C and C++ rules: `cc_library`, `cc_binary`, and `cc_test` declare
-- graph tasks directly.
--
-- A dependency is a value, not a label. A `cc_library` result goes directly
-- into the `deps` of a `cc_binary`. The result of a library has these
-- fields, which are a contract between modules:
--
--   archive, transitive_archives, transitive_shared_libs,
--   transitive_import_libs, transitive_include_dirs, transitive_hdrs,
--   transitive_linkopts, and the BUILD and PACKAGE slots.
--
-- A CMake target can give the same fields, so that `cc_binary` links against
-- it as it links against a `cc_library`.
--
-- Static archives and shared libraries are in different lists. `ar` and the
-- linker both read an archive. Only the linker reads a shared library, and
-- `ar` must never receive one. Both lists are mounted into the sandbox. A
-- binary with a shared library in its closure carries the library: its
-- product is a directory with the executable and the libraries, linked with
-- `-Wl,-rpath,$ORIGIN`. See `binary_product` in
-- @imp/rules/workflows/package.
--
-- One task builds each target. Its run callback starts one compile action
-- for each source file, and then one archive or link action. One script that
-- compiles hundreds of sources is too long for one command line (issue #84),
-- and one action for each object lets the cache keep each object. The archive
-- or link action can also list hundreds of paths, so these paths go through
-- a response file. See `rspfile_argv`.
--
-- Headers are task inputs, so a header change starts a new compile. The rule
-- does not examine each header.
--
-- Differences from the JavaScript module:
--   - The Luau host runs one action at a time, so the compile actions of a
--     target run one after another.
--   - BUILD generation from CMakeLists.txt and main() detection is in
--     @imp/rules/c/generate_build.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local run_workflow = require("@imp/rules/workflows/run")
local test_workflow = require("@imp/rules/workflows/test")
local codegen = require("@imp/rules/imp/codegen")
local c_toolchain = require("@imp/rules/c/toolchain")
local gcc = require("@imp/rules/c/gcc")
local zig = require("@imp/rules/c/zig")
local output = core.output

local BUILD = build.BUILD
local PACKAGE = package.PACKAGE
local RUN = run_workflow.RUN
local TEST = test_workflow.TEST

local DEFAULT_CPP_SRCS = table.freeze({ "*.c", "*.cc", "*.cpp", "*.cxx" })
local DEFAULT_CPP_HDRS = table.freeze({ "*.h", "*.hh", "*.hpp", "*.hxx" })

local CXX_EXTENSIONS = table.freeze({ cc = true, cpp = true, cxx = true })
local SOURCE_EXTENSIONS = table.freeze({ c = true, cc = true, cpp = true, cxx = true })
local HEADER_EXTENSIONS = table.freeze({ h = true, hh = true, hpp = true, hxx = true })
local RESERVED_OUTPUT_EXTENSIONS = table.freeze({ a = true, so = true, dll = true, exe = true })

local function extension(path)
	local found = string.match(path, "%.([^./]+)$")
	return if found then string.lower(found) else nil
end

local function is_cxx_source(path)
	return CXX_EXTENSIONS[extension(path)] == true
end

local function is_cc_source(path)
	return SOURCE_EXTENSIONS[extension(path)] == true
end

local function is_cc_header(path)
	return HEADER_EXTENSIONS[extension(path)] == true
end

local function append(list, values)
	for _, value in ipairs(values) do
		table.insert(list, value)
	end
	return list
end

local function concat_lists(...)
	local result = {}
	for index = 1, select("#", ...) do
		append(result, (select(index, ...)))
	end
	return result
end

--- Collect `dep[field]` of each dependency into one list. A dependency
--- without the field gives no values.
local function from_deps(deps, field)
	local result = {}
	for _, dep in ipairs(deps) do
		append(result, dep[field] or {})
	end
	return result
end

local function normalize_workspace_path(path)
	local parts = {}
	for part in string.gmatch(path or ".", "[^/]+") do
		if part == ".." then
			error(`C/C++ paths must stay within the workspace: {path}`, 0)
		end
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end

local function output_slug_for(path)
	return if path == "." then "root" else (string.gsub(path, "/", "_"))
end

local function output_name_for(path, output_name)
	if output_name == nil then
		return output_slug_for(path)
	end
	if
		type(output_name) ~= "string"
		or output_name == "."
		or output_name == ".."
		or RESERVED_OUTPUT_EXTENSIONS[extension(output_name)] == true
		or string.match(output_name, "^[%w_%.%-]+$") == nil
	then
		error(
			"C/C++ output_name must be a non-empty portable filename stem containing only A-Z, a-z, 0-9, '.', '_' or '-'",
			0
		)
	end
	return output_name
end

-- On Windows, the sh.exe of Git for Windows cuts each argv element at
-- approximately 8186 bytes and gives no error. A script that lists each
-- object, archive, and link option thus fails for a target with many
-- sources. The variable part therefore goes into a response file. Its
-- content goes through many small argv elements, and the script stays small
-- and fixed.
local RSPFILE_CHUNK_SIZE = 4000

local function chunk_rspfile_content(content)
	local chunks = {}
	for start = 1, #content, RSPFILE_CHUNK_SIZE do
		table.insert(chunks, string.sub(content, start, start + RSPFILE_CHUNK_SIZE - 1))
	end
	return chunks
end

--- The argv of an action that writes `content` to `rsp_path` and then runs
--- `command`. `command` must read the file through `@<rsp_path>`. ar, gcc,
--- clang, and zig read response files with the quoting of `rsp_quote`.
local function rspfile_argv(display_name, rsp_path, content, command)
	local script = `set -e; rsp=$1; shift; : > "$rsp"; for chunk; do printf '%s' "$chunk" >> "$rsp"; done; {command}`
	return append({ "sh", "-c", script, display_name, rsp_path }, chunk_rspfile_content(content))
end

-- Resolve `toolchain` to a provider: a union selects the provider of the
-- host, and a provider stays the same. Without a toolchain, use the declared
-- zig default, then the declared gcc default. Each provider has the same
-- fields (see @imp/rules/c/toolchain), so the code below does not examine
-- the kind of the provider.
local function resolve_toolchain(toolchain)
	local resolved = c_toolchain.select_cc_toolchain(toolchain)
		or zig.default_graph_toolchain()
		or gcc.default_graph_toolchain()
	if resolved == nil then
		error(
			"cc_library()/cc_binary() need an explicit toolchain or a declared gcc/zig default - see @imp/rules/c/gcc, @imp/rules/c/zig",
			0
		)
	end
	return resolved
end

local function object_path_for(output_name, source)
	return `build/c/obj/{output_name}/{string.gsub(source, "[^%w_%.%-]", "_")}.o`
end

-- The platform filename of a shared library. With the `lib` prefix, the
-- file that the loader looks for and the file that Imp builds have the same
-- name, so `imp package` can publish it under a name that the loader finds.
-- Windows uses `<name>.dll`. macOS is not a supported target of the C rules.
local function shared_lib_filename(name)
	return if core.platform_info().os == "windows" then `{name}.dll` else `lib{name}.so`
end

-- Each spec that `cc_library`, `cc_binary`, and `cc_test` declare, in
-- declaration order. The BUILD generator of the C rules reads it to find
-- duplicates.
local cc_specs = {}

--- Return a copy of the list of declared target specs.
local function cc_workload_specs()
	return table.clone(cc_specs)
end

local function crate_spec(options)
	options = options or {}
	local path = normalize_workspace_path(options.path or core.package_path())
	local rule = "cc_library/cc_binary"
	local spec = {
		path = path,
		srcs = table.clone(options.srcs or DEFAULT_CPP_SRCS),
		hdrs = table.clone(options.hdrs or DEFAULT_CPP_HDRS),
		-- Generated sources and headers from the graph, a `codegen()` result
		-- or `{ artifact, path }`. The task stages each one at its declared
		-- workspace path. See @imp/rules/imp/codegen.
		generated_srcs = codegen.dedupe_generated_srcs(
			codegen.normalize_generated_srcs(options.generated_srcs or {}, { rule = rule }),
			{ rule = rule }
		),
		deps = options.deps or {},
		toolchain = resolve_toolchain(options.toolchain),
		copts = table.clone(options.copts or {}),
		linkopts = table.clone(options.linkopts or {}),
		-- The directory slug is the build namespace. `output_name` is an
		-- optional filename stem for two targets in one directory. Without
		-- it, the output and cache paths do not change.
		output_slug = output_slug_for(path),
		output_name = output_name_for(path, options.output_name),
		shared = options.shared == true,
		-- Skip the path guard of the Bootlin toolchain wrapper, which rejects
		-- -I and -L flags under /usr/include and /usr/lib. A target that links
		-- against a host system package, such as libwebkit2gtk-4.1, needs it.
		unsafe_system_paths = options.unsafe_system_paths == true,
	}
	table.insert(cc_specs, spec)
	return spec
end

-- Declare the task that compiles each source of `spec` and then archives
-- (a library) or links (a shared library or a binary) the objects.
local function cc_task(spec, is_library)
	local is_shared = is_library and spec.shared
	local srcs = core.files({ root = spec.path, include = spec.srcs })
	local hdrs = core.files({ root = spec.path, include = spec.hdrs })

	-- Each generated file is its own artifact, not part of a glob. A generated
	-- source compiles as a globbed source does. A generated header is mounted,
	-- and `-I<spec.path>` finds it.
	local generated_srcs = spec.generated_srcs
	local generated_source_keys = {}
	local generated_keys = {}
	for index, generated in ipairs(generated_srcs) do
		local expected_path = generated.expected_path
		if not is_cc_source(expected_path) and not is_cc_header(expected_path) then
			error(`cc_library/cc_binary generated_srcs '{expected_path}' is neither a C/C++ source nor a header`, 0)
		end
		local key = `generated{index}`
		table.insert(generated_keys, key)
		if is_cc_source(expected_path) then
			table.insert(generated_source_keys, key)
		end
	end

	local transitive_archives = from_deps(spec.deps, "transitive_archives")
	-- Shared libraries of the dependencies go to the link step and into the
	-- sandbox, never to the `ar` step.
	local transitive_shared_libs = from_deps(spec.deps, "transitive_shared_libs")
	-- Only the `transitive_linkopts` of the dependencies go to the link step
	-- of this target. Its own `linkopts` are not transitive.
	local transitive_linkopts = from_deps(spec.deps, "transitive_linkopts")
	-- A dependency without header handles, such as a CMake target, gives no
	-- headers to mount.
	local transitive_hdrs = from_deps(spec.deps, "transitive_hdrs")

	-- gcc, clang, and cl.exe add ".exe" to an output name without it on
	-- Windows. The declared output path must thus have it, or the declared
	-- file is never written.
	local windows = core.platform_info().os == "windows"
	local exe_name = spec.output_name .. (if windows then ".exe" else "")
	local product = if is_library
		then nil
		else package.binary_product({
			namespace = "c",
			target_slug = spec.output_slug,
			executable_name = exe_name,
			shared_libraries = transitive_shared_libs,
			bundle_display = `cc bundle {spec.path}`,
		})
	local out_path = if is_shared
		then `build/c/{shared_lib_filename(spec.output_name)}`
		elseif is_library then `build/c/{spec.output_name}.a`
		else `build/c/{exe_name}`
	-- A Windows shared library also writes an import library. MSVC
	-- `link.exe`, which Odin uses, cannot link against the DLL itself. Nil on
	-- other platforms and for other outputs.
	local import_lib = c_toolchain.import_lib_path(out_path, is_shared)
	-- The own path comes first, so that the headers of the target hide
	-- headers with the same name from dependencies.
	local include_dirs = concat_lists({ spec.path }, from_deps(spec.deps, "transitive_include_dirs"))

	local inputs = { srcs = srcs, hdrs = hdrs, opt_mode = core.semantic.mode("opt") }
	for index, generated in ipairs(generated_srcs) do
		inputs[`generated{index}`] = generated.artifact
	end
	for name, handle in pairs(spec.toolchain.task_inputs()) do
		inputs[name] = handle
	end
	for index, archive in ipairs(transitive_archives) do
		inputs[`archive{index}`] = archive
	end
	for index, shared_lib in ipairs(transitive_shared_libs) do
		inputs[`shared_lib{index}`] = shared_lib
	end
	for index, dep_hdrs in ipairs(transitive_hdrs) do
		inputs[`dep_hdrs{index}`] = dep_hdrs
	end
	local outputs = { artifact = output.artifact() }
	if import_lib then
		outputs.import_lib = output.artifact()
	end
	local action_kind = if is_shared then "shared-link" elseif is_library then "archive" else "link"

	local built = core.task({
		inputs = inputs,
		outputs = outputs,
		run = function(exec, input)
			for index, generated in ipairs(generated_srcs) do
				codegen.assert_generated_src_path(
					"cc_library/cc_binary",
					index,
					exec.path(input[`generated{index}`]),
					generated.expected_path
				)
			end
			local source_paths = table.clone(exec.paths(input.srcs))
			for _, key in ipairs(generated_source_keys) do
				table.insert(source_paths, exec.path(input[key]))
			end
			local needs_cxx = false
			for _, source in ipairs(source_paths) do
				needs_cxx = needs_cxx or is_cxx_source(source)
			end
			local compile_inputs = { input.srcs, input.hdrs }
			for index in ipairs(transitive_hdrs) do
				table.insert(compile_inputs, input[`dep_hdrs{index}`])
			end
			for _, key in ipairs(generated_keys) do
				table.insert(compile_inputs, input[key])
			end

			local commands = spec.toolchain.commands(exec, input, {
				unsafe_system_paths = spec.unsafe_system_paths,
			})
			-- One action for each source.
			local object_paths = {}
			local objects = {}
			for _, source in ipairs(source_paths) do
				local obj_path = object_path_for(spec.output_name, source)
				local tokens = commands.compile_command({
					source = source,
					obj_path = obj_path,
					is_cxx = is_cxx_source(source),
					include_dirs = include_dirs,
					opt = if input.opt_mode == "release" then "release" else "debug",
					copts = spec.copts,
					is_shared = is_shared,
				})
				-- The executor creates the parent directory of each declared
				-- file output, so the script has no mkdir.
				local result = exec.action({
					argv = { "sh", "-c", `set -e; {table.concat(tokens, " ")}`, "cc-compile" },
					env = commands.env,
					inputs = compile_inputs,
					outputs = { object = output.file(obj_path) },
					display = `cc compile {obj_path}`,
				})
				table.insert(object_paths, obj_path)
				table.insert(objects, result.outputs.object)
			end

			local rsp_quote = commands.rsp_quote
			local function quoted(values)
				local result = {}
				for _, value in ipairs(values) do
					table.insert(result, rsp_quote(value))
				end
				return table.concat(result, " ")
			end
			-- A produced object is in the next sandbox at its declared path, so
			-- the archive or link step uses `object_paths` directly.
			--
			-- `exec.path()` gives a path and does not mount the handle. Each
			-- object and dependency library must thus be in the action
			-- `inputs`, or the link fails with a missing file.
			local final_inputs = table.clone(objects)
			local dep_archive_paths = {}
			for index in ipairs(transitive_archives) do
				local archive = input[`archive{index}`]
				table.insert(dep_archive_paths, exec.path(archive))
				table.insert(final_inputs, archive)
			end
			local dep_shared_lib_paths = {}
			for index in ipairs(transitive_shared_libs) do
				local shared_lib = input[`shared_lib{index}`]
				table.insert(dep_shared_lib_paths, exec.path(shared_lib))
				table.insert(final_inputs, shared_lib)
			end
			local rsp_path = `build/c/{spec.output_name}.rsp`
			local final_argv
			if is_library and not is_shared then
				final_argv = rspfile_argv(
					`cc-{action_kind}`,
					rsp_path,
					quoted(object_paths),
					table.concat(commands.archive_command({ out_path = out_path, rsp_path = rsp_path }), " ")
				)
			else
				-- A GNU-style link resolves from left to right, so the shared
				-- libraries come after the archives.
				final_argv = rspfile_argv(
					`cc-{action_kind}`,
					rsp_path,
					quoted(
						concat_lists(
							object_paths,
							dep_archive_paths,
							dep_shared_lib_paths,
							spec.linkopts,
							transitive_linkopts
						)
					),
					table.concat(
						commands.link_command({
							out_path = out_path,
							is_cxx = needs_cxx,
							is_shared = is_shared,
							bundled = product ~= nil and product.bundled,
							rsp_path = rsp_path,
						}),
						" "
					)
				)
			end
			local action_outputs = { artifact = output.file(out_path) }
			if import_lib then
				action_outputs.import_lib = output.file(import_lib)
			end
			local result = exec.action({
				argv = final_argv,
				env = commands.env,
				inputs = final_inputs,
				outputs = action_outputs,
				display = `cc {action_kind} {out_path}`,
			})
			return { artifact = result.outputs.artifact, import_lib = result.outputs.import_lib }
		end,
	})
	return {
		built = built,
		hdrs = hdrs,
		product = product,
		import_lib = if import_lib then built.outputs.import_lib else nil,
	}
end

-- The TEST root of `cc_test`: run the executable and report its exit code as
-- one `{ name, ok, output }` unit. `allow_failure` makes a failing test a
-- reported unit and not a build error. A bundled binary starts from its
-- product directory, so `$ORIGIN` finds its shared libraries.
local function test_task(spec, executable, executable_path, bundled)
	return core.task({
		inputs = { artifact = executable },
		outputs = { units = output.value() },
		run = function(exec, input)
			local root = exec.path(input.artifact)
			local program = root
			if bundled then
				program = `{root}/{string.match(executable_path, "([^/]+)$")}`
			end
			local result = exec.action({
				argv = { program },
				inputs = { input.artifact },
				allow_failure = true,
				display = `cc test {spec.path}`,
			})
			return { units = test_workflow.test_vehicle(spec.path, result) }
		end,
	})
end

--- Declare a raw C/C++ library.
---
--- Options:
---   path                 Workspace-relative directory. The default is the
---                        directory of the calling BUILD module.
---   srcs                 Source globs. The default is DEFAULT_CPP_SRCS.
---   hdrs                 Header globs, which are inputs only. The default is
---                        DEFAULT_CPP_HDRS.
---   generated_srcs       `codegen()` results or `{ artifact, path }` tables.
---   deps                 `cc_library` results, or values with the same fields.
---   toolchain            A provider or a `cc_toolchain_for_platform` union.
---                        The default is the declared zig, then gcc, default.
---   copts                Extra compiler flags.
---   output_name          Portable filename stem of the output. The default
---                        is the directory slug.
---   unsafe_system_paths  Skip the Bootlin path guard, to link against host
---                        system packages. Zig has no such guard.
---   shared               Build a shared library (`lib<name>.so`, or
---                        `<name>.dll` with an import library `<name>.lib` on
---                        Windows) in place of a static archive.
---
--- Returns a frozen table with BUILD and PACKAGE slots and `archive`,
--- `transitive_archives`, `transitive_shared_libs`, `transitive_import_libs`,
--- `transitive_include_dirs`, `transitive_hdrs`, and `transitive_linkopts`.
local function cc_library(options)
	local spec = crate_spec(options)
	local declared = cc_task(spec, true)
	local archive = declared.built.outputs.artifact
	local dep_archives = from_deps(spec.deps, "transitive_archives")
	local dep_shared_libs = from_deps(spec.deps, "transitive_shared_libs")
	return table.freeze({
		spec = spec,
		[BUILD] = archive,
		archive = archive,
		transitive_archives = if spec.shared then dep_archives else concat_lists({ archive }, dep_archives),
		-- A shared library is in this list and in no other list, so that a
		-- consumer links against it and never gives it to `ar`.
		transitive_shared_libs = if spec.shared then concat_lists({ archive }, dep_shared_libs) else dep_shared_libs,
		-- The link-time part of a Windows shared library. Only the DLL goes
		-- beside an executable at run time. Empty on other platforms.
		transitive_import_libs = concat_lists(
			if declared.import_lib then { declared.import_lib } else {},
			from_deps(spec.deps, "transitive_import_libs")
		),
		transitive_include_dirs = concat_lists({ spec.path }, from_deps(spec.deps, "transitive_include_dirs")),
		transitive_hdrs = concat_lists({ declared.hdrs }, from_deps(spec.deps, "transitive_hdrs")),
		-- A library does not link, so its own `linkopts` are not here. Only
		-- the `transitive_linkopts` of its dependencies go through.
		transitive_linkopts = from_deps(spec.deps, "transitive_linkopts"),
		[PACKAGE] = archive,
	})
end

--- Declare a raw C/C++ binary. The options are those of `cc_library`
--- without `shared`, plus `linkopts`: extra linker flags for the link step of
--- this binary. The `transitive_linkopts` of the dependencies are added.
---
--- Returns a frozen table with BUILD, PACKAGE, and RUN slots. The product is
--- one executable file, or a directory with the executable and each
--- transitive shared library.
local function cc_binary(options)
	local spec = crate_spec(options)
	local declared = cc_task(spec, false)
	local product = declared.product.finish(declared.built.outputs.artifact)
	return table.freeze({
		spec = spec,
		[BUILD] = product.artifact,
		[PACKAGE] = product.artifact,
		[RUN] = product.run,
	})
end

--- Declare a raw C/C++ test binary: a `cc_binary` whose exit code is the
--- result of the test. The options are those of `cc_binary`.
---
--- The binary runs without arguments and without other mounts, so put the
--- assertions in `main()`. The result is one unit for each executable, as
--- for a CTest entry or a Rust test binary.
---
--- Returns a frozen table with BUILD, RUN, and TEST slots.
local function cc_test(options)
	local spec = crate_spec(options)
	local declared = cc_task(spec, false)
	local product = declared.product.finish(declared.built.outputs.artifact)
	return table.freeze({
		spec = spec,
		[BUILD] = product.artifact,
		[RUN] = product.run,
		[TEST] = test_task(spec, product.artifact, product.executable_path, product.bundled).outputs.units,
	})
end

return {
	DEFAULT_CPP_HDRS = DEFAULT_CPP_HDRS,
	DEFAULT_CPP_SRCS = DEFAULT_CPP_SRCS,
	cc_binary = cc_binary,
	cc_library = cc_library,
	cc_test = cc_test,
	cc_workload_specs = cc_workload_specs,
}
