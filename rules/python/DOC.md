The Python rules model projects declared in `pyproject.toml` files and uv
workspaces that lock several projects together. Applications build into
self-contained PEX files; tests use the locked workspace environment and run
pytest. This guide is for rule authors. Luau provides the core Python rules;
Ruff format and lint products remain available through the JavaScript rules.

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
IMP_RUNTIME=luau imp build //:app
IMP_RUNTIME=luau imp run //:app -- one "two words"
IMP_RUNTIME=luau imp test //:tests
IMP_RUNTIME=luau imp run '//:scripts#scripts/demo.py' -- one "two words"
IMP_RUNTIME=luau imp package //:app
```

`build` stores the PEX artifact in the CAS. `package` publishes it under
`dist/`. App and source runs stage their inputs in a sandbox and forward
arguments after `--`. They do not create a workspace `.venv`. Source patterns
are relative to the project; `python_sources` accepts direct patterns only.
Nested script directories require separate declarations.

**Limit:** The Luau CLI requires an explicit expansion selector such as
`//:scripts#scripts/demo.py`. Bare file-path lookup (`imp run scripts/demo.py`)
is not available in Luau yet; the JavaScript runtime retains that behavior.

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

**Limit:** Ruff is not part of the Luau core port. The JavaScript extension
examples below do not add format or lint slots to Luau targets. Generated
references still describe JavaScript; Luau reference extraction remains with
`2026-09-30-integrate-luau-workspace-tests-and-docs`.

From this repository root, validate the Luau package with the checkout binary:

```sh
cargo build -p imp
IMP_RUNTIME=luau target/debug/imp test //rules/python:rules_test
python3 rules/python/testdata/consumer_check.py --imp target/debug/imp
```

The consumer check needs network access for pinned tools and locked Python
dependencies. It checks root and nested PEX builds, a native wheel, package
publication, script runs, CLI arguments, source edits, and pytest failures in
a temporary workspace.

## JavaScript public API

Use `pythonWorkspace()` to declare a lock boundary and `pythonProject()` to
identify one member project. Use `pythonApp()`, `pythonTest()`, and
`pythonSources()` to declare build and run targets. The uv, Ruff, and PEX
toolchain modules expose configuration declarations; their download and cache
helpers are implementation details.

## Use the Luau toolchains

Rule authors on the migration branch can use the PEX and uv toolchains from
Luau. The core examples above also use Luau. Ruff and the remaining examples
below use JavaScript. Each runtime loads its own rule modules.

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
IMP_RUNTIME=luau imp goal gen-lockfiles //:pex //:uv
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

The generated references still describe the JavaScript APIs. Luau reference
extraction belongs to the workspace and documentation integration task.

## Set up the workspace

Import the Python rules in `imp.workspace.js`; they provide default uv, PEX,
and CPython toolchains. To format and lint Python targets with Ruff, import
`//rules/python/ruff/fmt` and `//rules/python/ruff/lint`. Each module adds one
product to `pythonApp()` targets. Without these imports, `imp fmt` and
`imp lint` select no Python targets:

```js
import "//rules/python";
import "//rules/python/ruff/fmt";
import "//rules/python/ruff/lint";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/test";

```

Keep one `uv.lock` at each uv workspace root. Imp locks all projects declared
as workspace members and syncs all member dependencies for Python targets in
that workspace. Builds and tests use `uv sync --locked`, so they fail rather
than resolve or mutate a stale lock file.

### Select a workspace lockfile

The rules ship a lockfile for each managed tool — uv, PEX and Ruff. It pins the
download URL, size, and SHA-256 of every release artifact, and it knows only
the versions the rules ship with. To pin a version that the shipped lockfile
does not know, give the toolchain the address of a lockfile that this
workspace owns. The shipped lockfiles stay the default.

```js
export const uvDefault = uvToolchain("0.11.17", {
	default: true,
	lockfile: "//locks/uv.lock",
});
export const pexDefault = pexToolchain("2.98.0", {
	default: true,
	lockfile: "//locks/pex.lock",
});
export const ruffDefault = ruffToolchain("0.15.22", {
	default: true,
	lockfile: "//locks/ruff.lock",
});
```

Export the lockfile generation roots, then write the three files:

```js
import { pexGenLockfiles, uvGenLockfiles } from "//rules/python";
import { ruffGenLockfiles } from "//rules/python/ruff_toolchain";

export const uvLockfiles = uvGenLockfiles();
export const pexLockfiles = pexGenLockfiles();
export const ruffLockfiles = ruffGenLockfiles();
```

```sh
imp goal gen-lockfiles //:uvLockfiles //:pexLockfiles //:ruffLockfiles
```

Each generation root writes to the address that its toolchain declares, so the
address is given one time only. Downloads stay verified: an address with no
file, or a lockfile with no entry for the selected version and platform, makes
the acquire fail and points at `imp goal gen-lockfiles`.

### Update a workspace lockfile

Declare a `pythonWorkspace()` at the uv workspace root. It exposes a
`gen-lockfiles` root that runs uv with the workspace's pyproject files and
writes only the workspace's `uv.lock`.

**Warning:** This command writes the generated `uv.lock` into the workspace.
It does not write a `.venv` or other project artifact.

```js
import { pythonWorkspace } from "//rules/python";

export const workspace = pythonWorkspace({ path: "." });
```

From the workspace root, run:

```sh
imp goal gen-lockfiles //:workspace
```

The command follows every project declared by the uv workspace. To upgrade one
package, change that project's dependency declaration, then run the command.
The goal does not accept a separate package-upgrade argument.

## Select a project

Each project maps to one `pyproject.toml`. A uv workspace can contain several
projects and shares one lockfile across them. By default, targets infer the
nearest project and its enclosing workspace from their `BUILD.js` directory.
Pass `project:` when a target must use another project:

```js
import { pythonProject, pythonWorkspace } from "//rules/python";

const workspace = pythonWorkspace({ path: "." });
const ml = pythonProject({
    workspace,
    path: "services/ml",
});
export const app = pythonApp({ project: ml, entryPoint: "acme.__main__" });
export const tests = pythonTest({ project: ml });
```

Current Python workspaces use the default dependency set. Axis-selected uv
extras are deferred.

## Declare an application and tests

```js
import { pythonApp, pythonTest } from "//rules/python";

export const app = pythonApp({
    sources: ["src/**/*.py"],
    entryPoint: "acme.__main__",
});

export const tests = pythonTest({
    sources: ["tests/**/*.py"],
    testArgs: ["-q"],
});
```

Both targets use the nearest project by default. Set `project` to select a
different project. `pythonApp` syncs the full locked workspace without
development dependencies and asks PEX to package the project and its
installed runtime dependencies. Its `sources` are application files only;
`pythonTest` owns test files and supplies the pytest, fmt, and lint roots.
`entryPoint` becomes the PEX entry point, while `extraPexArgs` is available
for PEX options that do not yet have a dedicated field.

`pythonApp`, `pythonTest`, and `pythonSources()` use the CPython version that
`pythonRuntime()` sets (default `3.13.0`). Apps and tests therefore use the
same interpreter, and source runs use it too. Call `pythonRuntime("3.12.4")`
in the workspace to change the default for all three target types. To use a
different version for one app or test, set `pythonVersion` on that target.
`pythonWorkspace()` also accepts `pythonVersion` to override the version used
to lock that workspace.

`sources` defaults to direct `*.py` files in the project directory. Nested
source directories must be declared explicitly. Use application patterns such
as `src/**/*.py` on `pythonApp` and test patterns such as `tests/**/*.py`
on `pythonTest`; ignored files are never staged. PEX adds only the
application sources, so tests and development-only files do not enter the
application archive.

`pythonTest` is intentionally separate from `pythonApp`: it does not build a
PEX first, and its `testArgs` are appended to `python -m pytest`. Successful
test tasks are reused when their inputs match; failures produce no cached
result and run again next time.

## Run source files

For direct script execution, declare one shallow source set rather than an
application target per file. It uses the Python rule's pinned runtime:

```js
import { pythonSources } from "//rules/python";

// BUILD.js
export const scripts = pythonSources({
    root: "tools",
    sources: ["*.py"],
});
```

Each direct match becomes one selectable child of the exported source set,
keyed by its workspace-relative path. Run it by file path, including arguments
after `--`:

```sh
imp run tools/demo.py -- --verbose
```

A bare path resolves to whichever exported source set claims that file,
searching the file's own package first and then each parent package, so the
`scripts` export above does not have to be named. When two source sets glob the
same file, the path is ambiguous and `imp` says so; select one explicitly by
its full child address instead:

```sh
imp run //tools:scripts#tools/demo.py -- --verbose
```

The source set's complete file list is staged and `root` is added to
`PYTHONPATH`. The `run` goal keeps the process sandboxed but sets its working
directory to the real workspace, so files written by the script persist there.
Nested directories need their own `pythonSources()` declaration; recursive
`**` patterns are rejected.

Sources do not require a project. They run with the pinned interpreter and the
standard library when no enclosing project exists. Otherwise, they use the
nearest project and its workspace. Pass `project:` to select another project:

```js
import { pythonProject, pythonWorkspace } from "//rules/python";

const workspace = pythonWorkspace({ path: "." });
export const project = pythonProject({ workspace, path: "python" });
```

Pass that project handle to a source set when it needs third-party dependencies:

```js
export const scripts = pythonSources({
    root: "tools",
    sources: ["*.py"],
    project,
});
```

## Run goals and find outputs

```sh
imp build //services/acme:app
imp test //services/acme:tests
imp fmt --check //services/acme:app
imp lint //services/acme:app
imp package //services/acme:app
```

`build` captures the generated `.pex` as a build artifact without writing it
into the source tree. `package` publishes it below
`dist/services/acme/app`. Formatting and linting are graph facets attached at
construction time by importing the Ruff extensions; select the application
target when checking the project's Python files.
