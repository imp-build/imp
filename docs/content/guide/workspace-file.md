+++
title = "Configure a workspace"
weight = 3
template = "page.html"
+++

This page is for users who configure rules, toolchains, execution limits, and
BUILD generation. Create `imp.workspace.luau` at the workspace root. Imp loads
it before the workspace's `BUILD.luau` modules.

## Enable workflows and rules

Require each workflow and rule that your BUILD modules use. Rule imports can
register schemas, toolchain defaults, and extensions.

**Illustrative example**

```luau
require("@imp/rules/c")
require("@imp/rules/workflows/test")
require("@imp/rules/odin/odinfmt")
require("@imp/rules/odin").odin_toolchain("dev-2026-03", { default = true })
return {
    imp = { jobs = 8, fs_jobs = 4, js_workers = 1, log_level = "info" },
    cache = { gc_max_age_days = 7 },
    odin = { collections = { lib = "library" } },
}
```

Configuration fields use `snake_case`. Return a table keyed by configuration
namespace. The loader validates fields and applies registered defaults. On
GitHub Actions, `imp.workspace.ci.luau` deep-merges over the base configuration.
The returned configuration does not declare selectable targets; put those in
BUILD modules.

`jobs` is a core budget. Actions declare their cost through `exec.action({ cores = n })`.
`fs_jobs` controls filesystem workers. CLI `--jobs`, `--fs-jobs`, `--js-workers`,
and `--level` override their corresponding settings.

`imp.passthrough_env` accepts bare environment names and fixed `NAME=value`
entries. The resolved environment contributes to action identity. Declare
only variables that the workspace needs.

**Runnable example**

```sh
# From a configured workspace root:
imp config schema --effective
```

## Import graph declarations

Use `@workspace/pkg/BUILD` to require a nested BUILD module. Use
`@workspace/helpers` for workspace helpers and `@imp/rules/...` for installed
rules. A workspace cannot replace installed rule modules. Each resolved source
has one cached module value.

## Generate BUILD declarations

Require the generator and enable its namespace's `build_generate` field.
For example, require `@imp/rules/rust/generate_build` and return
`rust = { build_generate = true }` in the workspace configuration.

**Runnable example**

```sh
imp goal generate-build --check
```

**Warning:** `imp goal generate-build` writes generated `BUILD.luau` files.
Imp refuses to replace a hand-written BUILD file. Already declared source
owners are excluded from generator discovery.

## Run a managed tool directly

`imp @odin ...`, `imp @ruff ...`, and other registered tools resolve the final
workspace default through the Luau toolchain registry. Import the toolchain
module and declare a default version before using the command. No fixed CLI
list of rule-owned tool names is required. See [Toolchains and caches](../toolchains-and-caches/).

Imp uses Luau for all workspace and BUILD modules. `IMP_RUNTIME` has no effect.
