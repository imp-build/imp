-- Documentation declarations for @imp/core. This file is never required.
-- @host tags are checked against the live Rust host API.
return {
    --- The `BUILD` workflow slot key.
    --- @host core.BUILD
    --- @category target
    ["BUILD"] = "BUILD",
    --- The `PACKAGE` workflow slot key.
    --- @host core.PACKAGE
    --- @category target
    ["PACKAGE"] = "PACKAGE",
    --- The `TEST` workflow slot key.
    --- @host core.TEST
    --- @category target
    ["TEST"] = "TEST",
    --- Find workspace files not owned by loaded graph source declarations or test roots.
    --- @host core.all_unowned
    --- @category target
    ["all_unowned"] = function(options) end,
    --- Bind the callback used by the CLI to resolve registered tool names.
    --- @host core.bind_tool_resolver
    --- @category target
    ["bind_tool_resolver"] = function(resolver) end,
    --- Capture files from the installed rules tree, independent of the workspace.
    --- @host core.builtin_files
    --- @category target
    ["builtin_files"] = function(options) end,
    --- Read the effective configuration namespace, or the supplied fallback.
    --- @host core.configuration
    --- @category configuration
    ["configuration"] = function(namespace, fallback) end,
    --- Return the registered configuration schemas.
    --- @host core.configuration_schemas
    --- @category configuration
    ["configuration_schemas"] = function() end,
    --- Deep-merge a declaration into a registered configuration namespace.
    --- @host core.configure
    --- @category configuration
    ["configure"] = function(namespace, value) end,
    --- Bind rebuild-axis values to a graph handle.
    --- @host core.configured
    --- @category configuration
    ["configured"] = function(source, overrides) end,
    --- Register the fields that a configuration namespace accepts.
    --- @host core.define_config_schema
    --- @category configuration
    ["define_config_schema"] = function(namespace, shape) end,
    --- Declare a mode axis with values, a default, and scope.
    --- @host core.define_mode_axis
    --- @category configuration
    ["define_mode_axis"] = function(name, options) end,
    --- Declare a named profile that selects mode values.
    --- @host core.define_profile
    --- @category target
    ["define_profile"] = function(name, values) end,
    --- Compares two CAS tree digests and returns a list of `{ type, path }` entries. `type` is `added`, `removed`, or `modified`. When all of a directory is added or removed, the list has one entry for the directory and no entries for its files. When a path changes between a file, a directory, and a symbolic link, the list has one `modified` entry for that path.
    --- @host core.diff_digests
    --- @category target
    ["diff_digests"] = function(before, after) end,
    --- Create a CAS tree digest from a map of relative paths to text.
    --- @host core.digest_from_text
    --- @category target
    ["digest_from_text"] = function(files) end,
    --- Declare dynamic graph children with `inputs` and a `create(inputs)` callback. Select children through `get(key, workflow, facet?)` or `all(workflow, facet?)`.
    --- @host core.expand
    --- @category target
    ["expand"] = function(options) end,
    --- Describe an array configuration field.
    --- @host core.field.array
    --- @category configuration
    ["field.array"] = function(item, options) end,
    --- Describe a `bool` configuration field. Options can declare a default and whether the field is required.
    --- @host core.field.bool
    --- @category configuration
    ["field.bool"] = function(options) end,
    --- Describe a configuration field constrained to the listed enum values.
    --- @host core.field.enum
    --- @category configuration
    ["field.enum"] = function(values, options) end,
    --- Describe a `int` configuration field. Options can declare a default and whether the field is required.
    --- @host core.field.int
    --- @category configuration
    ["field.int"] = function(options) end,
    --- Describe a configuration map with key and value field descriptors.
    --- @host core.field.map
    --- @category configuration
    ["field.map"] = function(key, value, options) end,
    --- Describe a nested configuration object.
    --- @host core.field.object
    --- @category configuration
    ["field.object"] = function(shape, options) end,
    --- Describe a `string` configuration field. Options can declare a default and whether the field is required.
    --- @host core.field.string
    --- @category configuration
    ["field.string"] = function(options) end,
    --- Capture workspace files from `paths`, or from `root`, `include`, and `exclude` globs. Exact paths omit missing files and reject directories and symbolic links.
    --- @host core.files
    --- @category target
    ["files"] = function(options) end,
    --- Requires an active goal callback in both check and write modes; otherwise fails with `core.generate_build() can only run in a goal callback`. Runs the registered BUILD generators. When `check` is false, writes the changed `BUILD.luau` files. Returns `{ changed, checked }`: the paths that changed or are stale, and the paths that the generators produced. The workflow reports the result. In check mode, the workflow fails the goal when a path is stale.
    --- @host core.generate_build
    --- @category target
    ["generate_build"] = function(check) end,
    --- Declare a workspace glob without claiming source ownership.
    --- @host core.glob
    --- @category target
    ["glob"] = function(options) end,
    --- Register a goal callback. Return its workflow slot key. Options declare flags and target-selection policy.
    --- @host core.goal
    --- @category target
    ["goal"] = function(name, run, options) end,
    --- Fails the goal with `message` as the full user-facing error, without a stack trace or engine context. If the goal catches this error and then raises a different error, Imp reports the different error with its full context.
    --- @host core.goal_error
    --- @category target
    ["goal_error"] = function(message) end,
    --- Returns the flags of the running goal. Declared flags are booleans. For `test`, the table also holds the `case` and `suite` strings when they are set. Fails outside a goal invocation with `core.goal_flags() can only run while a goal executes`.
    --- @host core.goal_flags
    --- @category target
    ["goal_flags"] = function() end,
    --- Decode a JSON string into a Luau value.
    --- @host core.json_decode
    --- @category target
    ["json_decode"] = function(text) end,
    --- Encode a value as formatted JSON with a final newline.
    --- @host core.json_encode
    --- @category target
    ["json_encode"] = function(value) end,
    --- Write a warning through the Imp logging system.
    --- @host core.log_warn
    --- @category target
    ["log_warn"] = function(message) end,
    --- Return the callback unchanged. This compatibility helper does not add a memo registry.
    --- @host core.memo
    --- @category target
    ["memo"] = function(callback) end,
    --- Register a named-cache detail callback at declaration time.
    --- @host core.named_cache_details
    --- @category target
    ["named_cache_details"] = function(options) end,
    --- Declare an executable that Imp finds on the host PATH.
    --- @host core.native_tool
    --- @category target
    ["native_tool"] = function(name) end,
    --- Declare a task artifact output.
    --- @host core.output.artifact
    --- @category target
    ["output.artifact"] = function() end,
    --- Declare a directory output, with an optional named-cache declaration.
    --- @host core.output.directory
    --- @category target
    ["output.directory"] = function(path, options) end,
    --- Declare one relative file output of an action.
    --- @host core.output.file
    --- @category target
    ["output.file"] = function(path) end,
    --- Declare a JSON-compatible task value output.
    --- @host core.output.value
    --- @category target
    ["output.value"] = function() end,
    --- Return the workspace-relative directory that owns the current module.
    --- @host core.package_path
    --- @category target
    ["package_path"] = function() end,
    --- Select a path inside a captured artifact.
    --- @host core.path
    --- @category target
    ["path"] = function(source, options) end,
    --- Return the effective `{ os, arch }` toolchain platform.
    --- @host core.platform_info
    --- @category target
    ["platform_info"] = function() end,
    --- Declare an interactive program with explicit `inputs` and a `describe(exec, inputs)` callback. The RUN workflow starts it at the goal boundary.
    --- @host core.program
    --- @category target
    ["program"] = function(options) end,
    --- Read text through a canonical `@workspace/...` or `@imp/rules/...` address. Return nil when no file exists.
    --- @host core.read_file
    --- @category target
    ["read_file"] = function(address) end,
    --- Reads one file from a CAS tree digest.
    --- @host core.read_file_in_digest
    --- @category target
    ["read_file_in_digest"] = function(digest, path) end,
    --- Register a `namespace` and `generate` callback for BUILD generation.
    --- @host core.register_build_generator
    --- @category target
    ["register_build_generator"] = function(options) end,
    --- Register the module, exported rule name, and renderer metadata of a BUILD declaration.
    --- @host core.register_build_rule
    --- @category target
    ["register_build_rule"] = function(options) end,
    --- Returns the CLI arguments after `--`, or an empty array outside a goal invocation.
    --- @host core.run_args
    --- @category target
    ["run_args"] = function() end,
    --- Runs one interactive program and returns `{ exit_code, stdout, stderr }`. `inputs` holds digests or artifact tables to stage, and `tools` holds tool handles. The host sets the `run` policy: the program is impure and sandboxed, starts in the real workspace, streams its output, and receives `core.run_args()` after `argv`. A nonzero exit fails the call. Outside a goal function, the call fails with `core.run_program() can only run in a goal callback`, except in a `core.test.with_fake_run` scope.
    --- @host core.run_program
    --- @category target
    ["run_program"] = function(options) end,
    --- Declare the running Imp executable as an action tool.
    --- @host core.self_tool
    --- @category target
    ["self_tool"] = function() end,
    --- Declare a graph input that reads one mode axis.
    --- @host core.semantic.mode
    --- @category target
    ["semantic.mode"] = function(axis) end,
    --- Describe a source field for registered BUILD rule rendering.
    --- @host core.sources_field
    --- @category target
    ["sources_field"] = function(options) end,
    --- Declare a cached graph task with `inputs`, `outputs`, `run`, optional `display`, and optional `cache`. The callback receives `(exec, inputs)`.
    --- @host core.task
    --- @category target
    ["task"] = function(options) end,
    --- Read a named-cache detail callback under a toolchain fake.
    --- @host core.test.cache_details
    --- @category target
    ["test.cache_details"] = function(name, seeded) end,
    --- Declare one named test callback.
    --- @host core.test.case
    --- @category target
    ["test.case"] = function(name, run) end,
    --- Resolve a task or program in the active test case.
    --- @host core.test.resolve
    --- @category target
    ["test.resolve"] = function(handle) end,
    --- Group test cases under a suite name.
    --- @host core.test.suite
    --- @category target
    ["test.suite"] = function(name, cases) end,
    --- Replace digest differences within a test callback.
    --- @host core.test.with_fake_diff
    --- @category target
    ["test.with_fake_diff"] = function(changes, callback) end,
    --- Set goal flags within a test callback.
    --- @host core.test.with_fake_goal_flags
    --- @category target
    ["test.with_fake_goal_flags"] = function(flags, callback) end,
    --- Run a callback with recorded actions and programs instead of real processes.
    --- @host core.test.with_fake_run
    --- @category target
    ["test.with_fake_run"] = function(callback) end,
    --- Run a callback with a selected platform and recorded toolchain actions.
    --- @host core.test.with_fake_toolchain_host
    --- @category target
    ["test.with_fake_toolchain_host"] = function(platform, callback) end,
    --- Record workspace publication calls during a test callback.
    --- @host core.test.with_fake_write_workspace
    --- @category target
    ["test.with_fake_write_workspace"] = function(callback) end,
    --- Declare tests owned by the current BUILD package. Discover package-local `.test.luau` files.
    --- @host core.test_root
    --- @category target
    ["test_root"] = function() end,
    --- Declare an acquired tool from an artifact. Options contain `name` and `bin_dirs`.
    --- @host core.tool
    --- @category target
    ["tool"] = function(source, options) end,
    --- Publishes a CAS artifact to the workspace. `merge = true` overlays files under the destination prefix and preserves unrelated files. With `merge`, `from` must select a directory; case aliases in the source tree, existing destination symlinks, and file/directory conflicts fail before publication. The default replaces the destination. Requires an active goal callback; otherwise fails with `core.write_workspace() can only run in a goal callback`. A `core.test.with_fake_write_workspace` scope records calls outside goal callbacks without writing files.
    --- @host core.write_workspace
    --- @category target
    ["write_workspace"] = function(path, digest, options) end,
    --- Select one named expansion child and its workflow handle.
    --- @category target
    ["Expansion.get"] = function(key, workflow, facet) end,
    --- Select the requested workflow of every expansion child. Use as a workflow root, not a task input.
    --- @category target
    ["Expansion.all"] = function(workflow, facet) end,
    --- Run a sandboxed argv action with declared inputs, tools, environment, and outputs. Return declared outputs and exit status.
    --- @category target
    ["exec.action"] = function(options) end,
    --- Capture `{ path, contents }` as a content artifact. Available only in task callbacks.
    --- @category target
    ["exec.file"] = function(options) end,
    --- Return the sandbox-relative path of a declared artifact or path handle.
    --- @category target
    ["exec.path"] = function(handle) end,
    --- Return the sorted captured paths of a declared file-set input.
    --- @category target
    ["exec.paths"] = function(handle) end,
    --- Return the CAS digest of a captured file set or artifact.
    --- @category target
    ["exec.digest"] = function(handle) end,
    --- Return the absolute named-cache directory for a declared acquired tool.
    --- @category target
    ["exec.tool_dir"] = function(handle) end,
    --- Start or reuse a declared persistent worker.
    --- @category target
    ["exec.worker_start"] = function(options) end,
    --- Named output handles of a declared task. Artifacts and JSON-compatible values have distinct output declarations.
    --- @category target
    ["Task.outputs"] = {},
}
