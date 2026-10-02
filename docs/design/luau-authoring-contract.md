# Luau authoring and module contract

**Status: Pilot.** This document describes the Luau runtime slice available in
the current Imp source tree. The existing JavaScript runtime remains the
default. Select Luau by adding `imp.workspace.luau` to the workspace root. A
workspace cannot contain both `imp.workspace.js` and `imp.workspace.luau`.

The pilot loads workspace `BUILD.luau` files and installed Luau rules. It
provides the `asset` and `resource_package` rules and runs their `build` tasks
through Imp's hermetic executor. The pilot does not migrate the complete rule
catalog, implement toolchain downloads, or provide all JavaScript workspace
configuration and introspection features. Treat other APIs and behavior in
this document as planned unless this section or a later section marks them
available.

## Current host capabilities

**Verified:** The current implementation is in
`crates/imp-engine/src/luau.rs`. This table records its public host surface and
the gaps that block catalog migration.

| Area | Current Luau behavior | Migration gap |
| --- | --- | --- |
| Module loading | Loads `@imp/core`, `@imp/rules/...`, and `@workspace/...`; caches canonical module values and rejects namespace escapes. | The full catalog and its loader-dependent workspace features are not migrated. |
| Workspace configuration | Loads `imp.workspace.luau`; on GitHub Actions it deep-merges `imp.workspace.ci.luau`. Luau rule modules can register schemas, read or write configuration, and expose schemas and resolved values to the CLI. | JavaScript and Luau use different field spellings. Luau configuration uses `snake_case`; the JavaScript runtime remains the default. |
| BUILD discovery | Walks the workspace for `BUILD.luau` files and evaluates returned tables. `imp goal generate-build` can write and check generated `BUILD.luau` files from registered Luau generators. | Language-specific generators must be ported to Luau before a Luau workspace can use them. |
| Graph construction | Exposes `files`, `glob`, `task`, `output`, `native_tool`, `tool`, `path`, `platform_info`, `package_path`, `goal`, `test_root`, and opaque handles. Tasks declare named `value` or `artifact` outputs. `register_build_rule` and `register_build_generator` provide the Luau BUILD renderer interface. `memo`, `sources_field`, and `write_workspace` remain pilot shims. | APIs such as `cargoPackage`, full toolchains, and workspace graph introspection are missing. |
| Action execution | Runs hermetic argv actions with captured file-set and task-artifact inputs, declared file and directory outputs, native and acquired PATH tools, explicit environment settings, path resolution, and a cache toggle. Captured artifacts can flow to downstream tasks through named outputs. | Allow-failure results and broader toolchain conveniences are not available. |
| Tests and workflows | Luau BUILD modules can expose a `TEST` root. The root discovers package-local `.test.luau` modules and runs named cases and suites in fresh Luau runtimes. | The standard workflow rule modules and mixed JavaScript/Luau test discovery are not available in Luau. |
| Installed rules | The pilot tree contains Luau `asset`, `resource_package`, `workflows/build`, and `imp/native-tool` modules. | Other packages remain JavaScript; Luau workspaces cannot import those modules through the Luau loader. |

The shared C toolchain is the first consumer of `platform_info()`. C compiler
toolchains and Imp host rules are the first consumers of acquired tool handles,
path handles, and explicit action environment settings. The broader Tree-sitter
rule remains a later capability probe; its test and workspace requirements are
outside this host task.

The contract keeps Imp's graph values explicit across workspace files, BUILD
files, and rule modules. Every imported source has one stable identity, and
module ownership is clear from its address.

### Luau tests

A Luau BUILD module declares a test root by using `TEST` in the exported value
table:

```luau
local core = require("@imp/core")

return {
    rule_tests = { TEST = core.test_root() },
}
```

The root discovers `.test.luau` files directly inside its BUILD package. A
nested package owns its test modules through its own BUILD module and test
root. Each test module returns an array of `core.test.case(name, fn)` values or
`core.test.suite(name, cases)` values. Imp runs each case in a fresh Luau
runtime in the Imp process. Imp evaluates each test module once to discover its
cases and again for each selected case, so keep module-level code declarative
and free of side effects. Test modules and cases do not run inside action
sandboxes. The case and suite structure follows the [Lute test guide](https://lute.luau.org/guide/writing-tests/),
but Imp uses its embedded host and does not invoke the Lute CLI.

Select a Luau test root with `imp test //pkg:rule_tests`. Add `--case NAME` to
run a named case or `--suite NAME` to run a named suite. These flags apply only
to Luau workspaces. Imp reports each case as a test unit. Failures include the
test module's canonical workspace address and source location. If a filter
matches no tests, Imp reports that as a test failure.

A workspace selects one authoring runtime: it cannot contain both
`imp.workspace.js` and `imp.workspace.luau`. Luau test roots discover only
`.test.luau` modules. JavaScript test roots retain their existing
`_test.js` discovery path.

### Task and action outputs

Read the `output` table from `@imp/core`. A task declares named `output.value()` or
`output.artifact()` slots. Its `run(exec, inputs)` callback returns a table
with the same names. Value slots carry JSON-compatible data. Artifact slots
carry artifact handles returned by an action.

An action declares workspace-relative paths with `output.file(path)` or
`output.directory(path)`. A directory may also declare a named cache with
`output.directory(path, { named_cache = { name, key } })`. The execution
service captures outputs in CAS, writes named-cache outputs to the tool cache,
and returns artifact handles under `result.outputs`. A task may return one of
those handles from its matching artifact slot. A downstream task may declare
that task output in `inputs`; Imp executes the producer first and supplies the
resolved value or artifact handle to the consumer. When an action consumes an
artifact or path handle, Imp stages its CAS digest as an action input. Graph
actions keep outputs in CAS and do not write them into the workspace.

### Tool, path, platform, and environment APIs

`platform_info()` returns the host `os` and `arch` values used for toolchain
selection. `path(artifact_output)` and `tool(artifact_output, options)` create
opaque handles from declared task artifact outputs. Each handle captures the
active BUILD package context and has a stable graph identity for equivalent
declarations in that package. Tool options require `name` and may set
`bin_dirs`, which defaults to `{ "." }`. A tool source must be a directory
artifact with a named-cache declaration.

Pass tool and path handles through a task's `inputs`. The tool handle makes the
cached tool available on the sandbox action's `PATH`. `exec.path(path_handle)`
returns the artifact's workspace-relative path inside the sandbox; include the
same path handle in `exec.action({ inputs = ... })` to stage the artifact.
`exec.action({ env = { NAME = "value" } })` adds explicit environment values
to the action. These values are part of the action environment and cache key.
Lockfile selection, checksum verification, downloads, and archive extraction
remain rule-module policy built from graph tasks and actions.

**Illustrative example:**

```luau
local core = require("@imp/core")
local output = core.output
local install = core.task({
    inputs = {
        sh = core.native_tool("sh"),
        mkdir = core.native_tool("mkdir"),
        chmod = core.native_tool("chmod"),
    },
    outputs = { root = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = {
                "sh", "-c",
                "mkdir -p .imp/tool && printf '#!/bin/sh\\nexit 0\\n' > .imp/tool/example && chmod +x .imp/tool/example",
            },
            outputs = {
                root = output.directory(".imp/tool", {
                    named_cache = { name = "example-tools", key = "1.0/linux-x86_64" },
                }),
            },
        })
        return { root = result.outputs.root }
    end,
})
local tool = core.tool(install.outputs.root, { name = "example" })
local root_path = core.path(install.outputs.root)
local check = core.task({
    inputs = { example = tool, root = root_path },
    run = function(exec, inputs)
        assert(exec.path(inputs.root) == ".imp/tool")
        exec.action({
            argv = { "example" },
            inputs = { inputs.root },
        })
    end,
})
```

The example shows host handle declarations. A rule module must build or
acquire the tool directory and name the cache key from its pinned version and
platform data before it declares the tool handle.

**Illustrative example:**

```luau
local core = require("@imp/core")
local output = core.output

local generate = core.task({
	outputs = { source = output.artifact() },
	run = function(exec)
		local result = exec.action({
			argv = { "sh", "-c", "printf generated > generated.txt" },
			outputs = { source = output.file("generated.txt") },
		})
		return { source = result.outputs.source }
	end,
})

local consume = core.task({
	inputs = { source = generate.outputs.source },
	outputs = { status = output.value() },
	run = function(exec, inputs)
		exec.action({
			argv = { "sh", "-c", "test -s generated.txt" },
			inputs = { inputs.source },
		})
		return { status = "ok" }
	end,
})
```

## Module addresses

Luau modules use `require()` with one of three absolute address namespaces:

| Address | Owner | Source |
| --- | --- | --- |
| `@imp/core` | Imp runtime | Host APIs and opaque graph handles |
| `@imp/rules/<path>` | Imp distribution | The installed rule tree beside the executable |
| `@workspace/<path>` | Current workspace | A source below the workspace root |

The namespaces do not overlap. `@imp/rules/...` always resolves in the
installed rule tree. This changes the current JavaScript loader, where a
workspace file at `//rules/...` takes precedence over the installed rule. A
workspace that needs different behavior must use its own `@workspace/...`
module and import or wrap the installed rule explicitly. It cannot replace the
installed source by copying a file to the same relative path.

The root workspace BUILD module is `@workspace/BUILD`. Other workspace BUILD
modules use `@workspace/<package>/BUILD`. The workspace configuration module
is `@workspace/imp.workspace`. On GitHub Actions, the loader also evaluates
`@workspace/imp.workspace.ci` when `imp.workspace.ci.luau` exists. Both
modules may return a table keyed by registered configuration namespace; the
CI table deep-merges over the workspace table. Rule modules register their
namespaces before the workspace configuration is validated.

## Workspace configuration

Luau rule modules use `define_config_schema(namespace, shape)` to register a
namespace. The `field` table provides `int`, `string`, `bool`, `enum`,
`object`, `map`, and `array` descriptors. Descriptor options are `default` and
`required`. Configuration fields use `snake_case`, even when the matching
JavaScript field uses `camelCase`.

The Imp-owned `imp` namespace accepts `js_workers` (JavaScript workers),
`jobs`, `fs_jobs`, `passthrough_env`, and `log_level`. The `cache` namespace
accepts `gc_max_age_days`. These retain the JavaScript runtime's behavior.
The JavaScript runtime continues to use `jsWorkers`, `fsJobs`,
`passthroughEnv`, `logLevel`, and `gcMaxAgeDays`.

Workspace configuration returns one table with namespace names as keys. The
loader validates declared fields, applies defaults, and reports the source
module address and field path for invalid values. `configure(namespace,
value)` merges a value into a namespace. `configuration(namespace, fallback)`
reads it. `configuration_schemas()` returns the schemas registered by loaded
rule modules.

Run `imp config schema` to print registered schemas. Add `--effective` to
include the resolved workspace configuration. CLI option names use
`kebab-case`; existing option names remain unchanged.

An address is a slash-separated path. It may omit `.luau`; if present, the
resolver removes that suffix before checking these source forms in order:

1. `<path>.luau`
2. `<path>/index.luau`
3. `<path>/BUILD.luau`

The empty workspace path resolves to the root `BUILD.luau`. The `@imp/core`
module is provided by the host and does not resolve to a file.

Relative `./` and `../` imports resolve from the importing source file. They
retain its namespace: a relative import from `@workspace/app/main` stays under
`@workspace`, and one from `@imp/rules/rust` stays under `@imp/rules`. The
resolver removes `.` segments and resolves `..` segments before loading. It
rejects an import that escapes its namespace root, an absolute filesystem path,
or an unsupported bare module name.

## Canonical identity and cache

The resolver first maps an address to one source file. It then forms the
canonical module address from the namespace and the resolved, root-relative
source path, without the `.luau` suffix. Thus a directory import and an
explicit relative import that select the same `index.luau` share one module
value. A direct source, an index source, and a BUILD source remain distinct
when they are different files.

The canonical module address is also the module cache key. Equivalent
spellings, including optional `.luau` suffixes and normalized relative paths,
must return the same module value within one runtime. Workspace and installed
rule sources remain distinct even when their relative paths match. The cache
uses logical addresses, not absolute host paths, so it does not change when a
checkout moves.

## Generated BUILD modules

Luau rule modules may register a BUILD renderer with
`core.register_build_rule({ rule, module, export })`. `module` must name a
file-backed `@imp/rules/...` or `@workspace/...` module. `export` defaults to
`rule`.

Register a generator with
`core.register_build_generator({ namespace, generate })`. The namespace must
have a `build_generate` boolean configuration field. Imp runs the generator
only when that value is true. The callback returns a table keyed by
workspace-relative `BUILD.luau` paths. Each value is an array of
`{ name, rule, props }` targets. Imp merges targets from all enabled
generators before it renders each file.

Run `imp goal generate-build` to write generated files. Run
`imp goal generate-build --check` to report stale files without writing.
Generated files have an Imp header and Imp refuses to replace a hand-written
file at the same path. Target names and registered exports must be Luau
identifiers. The loader discovers generated files through the same canonical
`@workspace/<package>/BUILD` addresses as hand-written BUILD modules.

Resolution errors identify the importing canonical address, requested
specifier, and the import call's source location when available. Source
locations use the canonical source address with line and column. Parse and
runtime errors identify the address and line and column in the source that
failed. Errors must name the namespace root that was searched. A missing
installed rule is reported as an installed rule lookup failure; the resolver
does not silently substitute a workspace module.

## Module values and graph declarations

Each module returns exactly one value. A module with named exports returns a
table. Rule modules expose public functions, configuration, and intentional
registration values as named fields in that table. Private helpers remain
private to their source module.

Workspace and BUILD modules return tables whose named fields declare graph
roots. A graph root is an opaque userdata value created by `@imp/core` or a
rule factory. The host reads the field name as the exported target name; it
does not inspect or serialize the userdata. A module may also export ordinary
values used to configure other declarations, but those values are not graph
roots.

Each BUILD module evaluates with a package context set to its own workspace
directory. An imported BUILD module uses its own context while it evaluates;
after it returns, the importing module's context is restored. An ordinary
workspace or rule module has no package context by itself. A helper called
during BUILD evaluation sees the active BUILD caller's context, regardless of
which module defines the helper. A graph factory captures that context when it
creates a handle, so deferred behavior keeps its declaration context after
module evaluation and across async calls. Code outside BUILD evaluation or a
recorded callback cannot query the active BUILD package context.

Target addresses are derived from the BUILD module that exports a graph root,
not from the module that created the handle. Re-exporting a handle under a
different BUILD module therefore changes its target address, while source
paths already captured by the handle keep their original package context.

Closures are Luau functions. Rule APIs may accept a closure for deferred graph
behavior, and the closure may capture graph userdata created during module
evaluation. Inline custom rule behavior is written as a Luau closure and passed
to the rule API that consumes it. The contract does not evaluate source strings
as code.

Relative imports are the supported way to share workspace-owned helpers or
private rule implementation modules. Rule implementations import other
installed rules through `@imp/rules/...`; workspace code imports selected
installed rules through that same address form.

## Option tables and language boundary

APIs that take a group of optional or named arguments use one Luau table.
Public option keys use `snake_case`. Each API documents which fields are
required and which defaults it applies.

The migration preserves Imp's graph model, rule ownership, loader boundaries,
and asynchronous host operations. It does not preserve JavaScript or ESM
language semantics. Authors must convert JavaScript source to Luau. In
particular, the contract provides no JavaScript globals, prototypes,
`import`/`export` syntax, or JavaScript Promise interop. Luau modules use
`require()` and return values; asynchronous host operations use the Luau
runtime's supported async calls. Imp does not add npm-style bare-package
lookup; imports use the explicit Imp and workspace addresses defined above.

## Available asset API

The installed module `@imp/rules/asset` exports `asset(options)` and
`resource_package(options)`. Both accept `srcs`, with optional `base`, `path`,
and `exclude` fields. The module returns `sources`, `BUILD`, and (for
`resource_package`) `files`. `srcs` contains workspace-relative glob patterns.
`asset` accepts an empty source list at declaration time; `resource_package`
requires at least one pattern.

The `BUILD` task declares the host `sh` executable and runs `sh -c true` with
the matched files as inputs. This verifies graph loading and hermetic action
execution. It does not create a bundle or output file. The asset rule disables
action caching. `native_tool("sh")` resolves an executable already on `PATH`;
it does not download or provision a toolchain.

```lua
local asset = require("@imp/rules/asset")

return {
	assets = asset.asset({ srcs = { "*.png", "*.svg" } }),
}
```

## Planned behavior

The following example shows planned APIs. It is not runnable with the current
pilot.

```lua
local imp = require("@imp/core")
local rust = require("@imp/rules/rust")
local shared = require("./shared")

local app = rust.cargo_package({
	path = "app",
	toolchain = shared.toolchain,
})

return {
	app = app,
	check = imp.task({
		inputs = { app = app },
		run = function(ctx)
			return shared.check(ctx, app)
		end,
	}),
}
```

The host API spellings in this example are illustrative. The pilot currently
provides only the APIs needed by the asset rule and build workflow.

In this example, `app` and `check` are graph roots because their values are
opaque graph handles. `shared` is workspace-owned because the relative import
inherits the importing module's `@workspace` namespace. Option-table keys use
`snake_case`; the Luau closure is passed as a function value.
