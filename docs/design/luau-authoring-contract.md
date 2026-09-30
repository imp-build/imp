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
| Workspace configuration | Loads `imp.workspace.luau`; on GitHub Actions it can deep-merge `imp.workspace.ci.luau`. | JavaScript configuration fields and introspection APIs are not at full parity. |
| BUILD discovery | Walks the workspace for `BUILD.luau` files and evaluates returned tables. | Generated BUILD discovery and mixed catalog dependencies are not supported. |
| Graph construction | Exposes `files`, `glob`, `task`, `native_tool`, `package_path`, `goal`, and opaque handles. `memo`, `sources_field`, `register_build_rule`, and `write_workspace` are pilot shims. | APIs such as `output`, `cargoPackage`, full toolchains, and workspace graph introspection are missing. |
| Action execution | Runs hermetic argv actions with captured file-set inputs, native PATH tools, and a cache toggle. | Actions do not yet expose declared outputs, output values, tool/path helpers, environment configuration, or allow-failure results. |
| Tests and workflows | The pilot can execute its asset build task. | The JavaScript test runner, `TEST` graph values, standard workflow APIs, and catalog test discovery are not available in Luau. |
| Installed rules | The pilot tree contains Luau `asset`, `resource_package`, `workflows/build`, and `imp/native-tool` modules. | Other packages remain JavaScript; Luau workspaces cannot import those modules through the Luau loader. |

The existing Tree-sitter rule is a useful next capability probe. It imports
`output`, `cargoPackage`, workflow and test modules, and uses action outputs,
tool handles, and path helpers. Those APIs must land with focused host tests
before that package can migrate. See `rules/treesitter/index.js` for the
current consumer surface.

The contract keeps Imp's graph values explicit across workspace files, BUILD
files, and rule modules. Every imported source has one stable identity, and
module ownership is clear from its address.

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
modules may return an `imp` table; the CI table deep-merges over the workspace
table. Other configuration namespaces are outside the pilot.

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
