The Python rules model projects declared in `pyproject.toml` files and uv
workspaces that lock several projects together. Applications build into
self-contained PEX files; tests use the locked workspace environment and run
pytest. This guide is for rule authors. Luau provides the core Python rules;
Ruff format and lint products are available through separate Luau facets.

<!-- capabilities -->

## Public API

### Use the Luau core rules

**Verified:** The migration branch provides `@imp/rules/python`. Its public
functions are `python_workspace`, `python_project`, `python_runtime`,
`python_app`, `python_test`, and `python_sources`. Options and returned fields
use `snake_case`. JavaScript remains available during the migration.

**Runnable example:** From a workspace with `pyproject.toml`, a locked
`uv.lock`, application files under `src/hello`, and pytest files under `tests`,
register workflows in `imp.workspace.luau`:

```lua
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/test")
require("@imp/rules/workflows/lockfiles")
return {}
```

Declare the workspace and targets in its root `BUILD.luau`:

```lua
local python = require("@imp/rules/python")
python.python_runtime("3.13.0")
local workspace = python.python_workspace({ path = "." })
local project = python.python_project({ workspace = workspace, path = "." })
return {
    workspace = workspace,
    app = python.python_app({
        project = project,
        entry_point = "hello.__main__",
        sources = { "src/**/*.py" },
    }),
    tests = python.python_test({ project = project, sources = { "tests/**/*.py" } }),
    scripts = python.python_sources({ root = "scripts" }),
}
```

From that workspace root, select the Luau runtime:

```sh
imp build //:app
imp run //:app -- one "two words"
imp test //:tests
imp run '//:scripts#scripts/demo.py' -- one "two words"
imp package //:app
```

Python apps stage only their declared source files under `.imp-pex-sources`
with paths relative to the project. This permits projects at the workspace
root and avoids a source-copy loop or one build argument per source file.
UV also receives the declared sources at their original project paths.

`build` stores the PEX artifact in the CAS. `package` publishes it under
`dist/`. App and source runs stage their inputs in a sandbox and forward
arguments after `--`. They do not create a workspace `.venv`. Source patterns
are relative to the project; `python_sources` accepts direct patterns only.
Nested script directories require separate declarations.

**Limit:** The Luau CLI requires an explicit expansion selector such as
`//:scripts#scripts/demo.py`. Bare file-path lookup (`imp run scripts/demo.py`)
is not available. Select the expansion child explicitly.

`python_project` accepts paths relative to its uv workspace, or paths already
prefixed with the workspace path. When `project` is absent, app and test rules
infer the nearest `pyproject.toml` above `base` (the BUILD package by default)
and the nearest enclosing `[tool.uv.workspace]` section. Source rules infer
from `root`. A script without a project uses `uv run --no-project`.

`python_runtime` sets the default CPython version, initially `3.13.0`.
App, test, and workspace declarations accept `python_version` overrides.
App and test declarations accept `uv_version`; apps also accept `pex_version`,
`entry_point`, and `extra_pex_args`. Tests accept `test_args`. Extra PEX and
pytest arguments retain the existing space-separated shell argument behavior.
`deps` contains native tool handles, declared with `core.native_tool`.

App targets expose `sources`, `python_sources`, `root`, and the `BUILD`,
`PACKAGE`, and `RUN` slots. Tests expose `root` and `TEST`. Source declarations
expose `root` and an expandable `RUN` slot keyed by workspace-relative file
paths. Workspace declarations expose their identity and `GEN_LOCKFILES`.
Python app and test hooks receive frozen source information, including
`source_patterns`; test hooks also receive `python_sources`.

The Luau PEX and uv modules provide graph tools and absolute cache environment
paths. Rules declare the tools and cache handles as graph inputs. The shared
caches retain acquired tools, uv data, managed Python, and PEX data.

From this repository root, validate the Luau package with the checkout binary:

```sh
cargo build -p imp
target/debug/imp test //rules/python:rules_test
python3 rules/python/testdata/consumer_check.py --imp target/debug/imp
```

The consumer check needs network access for pinned tools and locked Python
dependencies. It checks root and nested PEX builds, a native wheel, package
publication, script runs, CLI arguments, source edits, and pytest failures in
a temporary workspace.

## Use the Luau toolchains

Rule authors on the migration branch can use the PEX and uv toolchains from
Luau. The core examples above also use Luau. The generated reference describes these Luau declarations.

In `imp.workspace.luau`, register the lockfile workflow:

```lua
require("@imp/rules/workflows/lockfiles")
return {}
```

Workspace configuration registers workflows. BUILD exports create selectable
target addresses. In `BUILD.luau` at the workspace root, declare and export
the lockfile generation targets:

```lua
local pex = require("@imp/rules/python/pex_toolchain")
local uv = require("@imp/rules/python/uv_toolchain")

return {
    pex = pex.pex_toolchain("2.102.0", {
        default = true,
        lockfile = "@workspace/locks/pex.lock",
    }),
    uv = uv.uv_toolchain("0.12.13", {
        default = true,
        lockfile = "@workspace/locks/uv.lock",
    }),
}
```

Each declaration returns `version`, `lockfile`, and a `GEN_LOCKFILES` root.
Options are `default`, `lockfile`, and `unverified`. The default lockfiles
ship with Imp. Use an explicit `@workspace/locks/uv.lock` or
`@workspace/locks/pex.lock` address to select a workspace-owned file. A
workspace file does not replace a shipped `@imp/rules/` file. Missing files
or entries fail acquisition with a regeneration command. `unverified = true`
permits an unverified download and logs a warning.

**Warning:** This command writes the selected lockfiles into the workspace.

From that workspace root, generate the declared lockfiles with:

```sh
imp goal gen-lockfiles //:pex //:uv
```

The command selects the two BUILD exports and writes `locks/pex.lock` and
`locks/uv.lock`.

Contributors can check target discovery for this example and run the core
consumer checks. The command needs network access for tools and dependencies.
From the Imp checkout root, after building `target/debug/imp`, run:

```sh
python3 rules/python/testdata/consumer_check.py --imp target/debug/imp
```

For execution, `graph_toolchain(version)` returns `tool`, `cache_tool`, and
`version`. With no version, it selects the declared default. Declare both
handles as task inputs. Within the task, `pex_bin(exec, inputs.tool)` or
`uv_bin(exec, inputs.tool)` returns the absolute executable path.
`cache_env(exec, inputs.cache_tool)` returns an environment table. Pass the
tool and cache tool to the action. PEX is a Python zipapp: invoke its path
through a separately declared Python interpreter.

The cache tool uses empty `bin_dirs`, so its directory does not enter `PATH`.
It has a seed task, so the directory exists before its first
mount. PEX sets `PEX_ROOT`; uv sets `UV_CACHE_DIR` and
`UV_PYTHON_INSTALL_DIR`. These paths are absolute and refer to persistent
shared named caches. Reusing a seed preserves existing cache contents. PEX
acquisition uses a version-only key and one platform-independent artifact.
uv acquisition uses version/platform keys and supports Linux and macOS on
x86_64 and aarch64, plus Windows on x86_64.

`@imp/rules/python/lock` exports
`python_workspace_lock({ workspace, sources, uv, python_version })`.
`workspace` is a workspace-relative directory, or `"."`. `sources` supplies
the workspace metadata and existing lock. `uv` is the graph tool handle.
The result is a task handle for a `GEN_LOCKFILES` slot. This uncached task
runs `uv lock` with managed Python and captures only `uv.lock`. The goal
publishes that artifact; the task does not write workspace files directly.

## Set up a Luau workspace

To format and lint Python apps and tests, load both Ruff facets before
BUILD targets are declared. In `imp.workspace.luau`, use:

```lua
require("@imp/rules/python")
require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
return {}
```

Each facet adds its product to `python_app` and `python_test`. Import only
`fmt` or `lint` when you need one product. See the [Ruff guide](ruff/) for
configuration discovery, fixes, toolchain declarations, and limits.

## Run goals

From a configured Luau workspace, select a declared Python target:

```sh
imp build //app:app
imp test //app:tests
imp package //app:app
imp run //app:app -- --help
```

Build results stay in CAS. Package publishes under `dist/`. Source-run
expansions use explicit selectors such as `//app:scripts#scripts/demo.py`.
