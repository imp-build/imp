# Imp host and generation rules

Declare tools, generated sources, lockfile downloads, and rule tests.

See [Quality checks for Imp Luau modules](/reference/user-api/imp/luau/) for reusable authoring
source, formatter, and analyzer rules under `@imp/rules/imp/luau`.

## Public API

## Luau modules

`@imp/rules/imp/native-tool`, `self-tool`, `archive`, `lockfile`, `generate`,
`codegen`, and `toolchain` provide Luau modules. Imp uses Luau for workspace
and BUILD modules. See `docs/design/luau-authoring-contract.md`.

| Module | Luau export |
| --- | --- |
| `@imp/rules/imp/native-tool` | `native_tool(name)`: a graph tool handle for an executable on the host `PATH`. A name that is empty or not a string fails with `native_tool(name) requires a non-empty executable name`. |
| `@imp/rules/imp/self-tool` | `imp_tool`: a graph tool handle for the running Imp executable. Actions run it as `imp`. |
| `@imp/rules/imp/archive` | `extract_archive({ archive, dest, format, strip_components?, named_cache?, display? })` gives the directory artifact of an extracted `tar`, `tar.gz`, `tar.xz`, `zip`, or `zip-unix` archive. `extract_archive_tools(format)` lists the native tools that the extraction uses. |
| `@imp/rules/imp/lockfile` | `download_tool_artifact(options)` downloads a toolchain artifact and verifies it against its lockfile. `resolve_tool_lockfile`, `locked_download_argv`, `locked_download_tools`, `sha_tool_name`, and `lockfile_address_to_path` are the parts it uses. `lockfile_for(kind, version, fallback)` returns the lockfile address of a declared toolchain version. |
| `@imp/rules/imp/toolchain` | `define(name)` returns a kind table that keeps the declared versions and the default version of a toolchain: `declare`, `default`, `default_version`, `resolve_version`, `require_version`, `instance_for_version`, `resolve_unverified`, and `clear_default`. `bin(exec, tool, { sub_dir?, exe })` returns the absolute host path of an executable in an installed toolchain. |
| `@imp/rules/imp/generate` | `generated_files({ display?, tools?, inputs?, output_paths, argv })` declares a `GENERATE` root for `imp generate`. |
| `@imp/rules/imp/codegen` | `codegen(options)` takes the options of `generated_files()` and returns a frozen `{ paths, files, BUILD, CODEGEN }`. `stamp_file({ output, text })` returns a frozen `{ file, BUILD }`. `normalize_generated_srcs`, `dedupe_generated_srcs`, and `assert_generated_src_path` are internal to the language rules. |

Put a tool handle in the `inputs` of a task. Each action of that task can then
run the executable by name. The lookup occurs when the action runs, not when
the handle is declared. Luau has no `nativeToolSpec()`: Luau tasks take the
tool handle directly, so there is no legacy `run({ tools })` descriptor.

**Illustrative example**

```luau
local core = require("@imp/core")
local native = require("@imp/rules/imp/native-tool")

local version = core.task({
	inputs = { cmake = native.native_tool("cmake") },
	run = function(exec)
		exec.action({ argv = { "cmake", "--version" } })
	end,
})
```

Luau option keys use `snake_case`. `argv` of `generated_files()` and
`codegen()` is `function(exec, resolved)`, and it runs in the task: `resolved`
holds the resolved `tools` and `inputs`. Put tools in `tools` and run them by
name.

Artifact outputs stay separate from JSON-compatible value outputs:

- A `generated_files()` root resolves to one artifact for each output path
  (`out1`, `out2`, and so on) and to `before`, the CAS digest of the same paths
  in the workspace. The `generate` goal reads the path of each file from its
  artifact.
- The `CODEGEN` root of a `codegen()` result is the generator task. It
  resolves to one artifact for each output path.

**Verified:** on 2026-10-10, `generated_files()` reads the workspace with the
workspace file walk, which skips gitignored files. Thus `imp generate --check`
always reports a gitignored output path as out of date.

`download_tool_artifact()` reads its lockfile with `core.read_file()` when it
declares the task. A lockfile address must start with `@workspace/` or
`@imp/rules/`.

**Illustrative example**

```luau
local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")
local workflow = require("@imp/rules/workflows/generate")

return {
	version_file = {
		[workflow.GENERATE] = generate.generated_files({
			tools = { sh = core.native_tool("sh") },
			output_paths = { "gen/version.txt" },
			argv = function()
				return { "sh", "-c", "echo 1.0.0 > gen/version.txt" }
			end,
		}),
	},
}
```

A toolchain module calls `toolchain.define(name)` one time and declares each
version with `declare`. An install task publishes the toolchain into a named
cache, and `core.tool()` makes a tool handle on it. A task that needs an
absolute path declares the tool handle as an input and calls `toolchain.bin`
in its body. `@imp/rules/c/mold` is the first module with this shape.

**Illustrative example**

```luau
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")

local function linker_flags(tool)
	return core.task({
		inputs = { tool = tool },
		outputs = { flags = core.output.value() },
		run = function(exec, inputs)
			local linker = toolchain.bin(exec, inputs.tool, { sub_dir = "bin", exe = "cc.example" })
			return { flags = { "-C", `linker={linker}` } }
		end,
	})
end
```

## Modes and tests

Require `@imp/rules/imp/mode` to declare the `opt` axis and profiles.
Use `--profile release` or `--axis opt=release` for release mode.

Declare a TEST root with `core.test_root()`. Package-local `.test.luau`
modules return `core.test.case` and `core.test.suite` declarations. Host fakes
record actions, workspace writes, and digest differences. The
`//rules/imp:rules_test` target runs the host-helper tests.

CLI `imp @tool` resolves the final default through the toolchain registry.
Tasks use acquired tools as declared handles and resolve absolute paths with
`exec.tool_dir` or the toolchain helper's `bin` function.
