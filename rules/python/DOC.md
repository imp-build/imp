The Python rules model applications and pytest suites backed by a locked
`pyproject.toml` project. Applications build into self-contained PEX files;
tests create an isolated uv environment and run pytest. Ruff supplies the
format and lint products for application targets.

<!-- capabilities -->

## Set up the workspace

Import the Python rules in `imp.workspace.js`; they provide default uv, PEX,
and CPython toolchains. Add Ruff when Python targets should participate in
formatting and linting:

```js
import "//rules/python";
import "//rules/python/ruff_toolchain";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/test";

```

Projects are built with `uv sync --locked`. Keep `uv.lock` checked in and in
sync with `pyproject.toml`; builds and tests fail rather than resolving or
mutating a stale lock file.

## Select a dependency resolve

Declare a `pythonResolve()` for a locked project when applications or tests
need optional dependency flavors. A resolve uses uv's checked-in `uv.lock` as
the source of truth; each flavor selects one project extra at sync time.

```js
import { pythonResolve } from "//rules/python";

export const ml = pythonResolve({
    path: "services/ml",
    flavors: {
        default: { extra: "cpu" },
        cpu: { extra: "cpu" },
        cu124: { extra: "cu124" },
    },
});
```

Then pass it to targets; the resolve supplies their project path (so do not
also set `src`):

```js
export const app = pythonApp({ resolve: ml, entryPoint: "acme.__main__" });
export const tests = pythonTest({ resolve: ml });
```

Choose a flavor with `--axis python=cu124`. A workspace can also define a
named `--profile` containing `python: "cu124"`. The resolve's `pyproject.toml`
must declare the matching uv extra and use uv's explicit indexes/sources to
bind PyTorch packages to the CPU or CUDA index. Flavors are deliberately
extras rather than package-version syntax: uv locks the real PyTorch local
version (for example `+cu124`) and PEX packages the resulting synced venv.

```js
// imp.workspace.js
import { defineProfile } from "imp:core";
defineProfile("cu124", { python: "cu124" });
```

## Declare an application and tests

```js
import { pythonApp, pythonTest } from "//rules/python";

export const app = pythonApp({
    entryPoint: "acme.__main__",
});

export const tests = pythonTest({
    testArgs: ["-q"],
});
```

Both targets default to the directory containing `BUILD.js`; set `src` to
point at another project directory. `pythonApp` syncs the locked environment
and asks PEX to package the project and its installed dependencies. `entryPoint`
becomes the PEX entry point, while `extraPexArgs` is available for PEX options
that do not yet have a dedicated field.

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

Each direct match is lazily expanded into one `python-source` target. This is
the remaining discovery-backed compatibility bridge while graph-root selection
is designed in #8. Run it
by file path, including arguments after `--`:

```sh
imp run tools/demo.py -- --verbose
```

The source set's complete file list is staged and `root` is added to
`PYTHONPATH`. The `run` goal keeps the process sandboxed but sets its working
directory to the real workspace, so files written by the script persist there.
Nested directories need their own `pythonSources()` declaration; recursive
`**` patterns are rejected.

Sources do not require a project. They run with the pinned interpreter and
the standard library by default. A workspace may declare one optional locked
project to supply third-party dependencies:

```js
import { pythonResolve } from "//rules/python";

export const project = pythonResolve({ path: "python" });
```

Pass that resolve to a source set when it needs third-party dependencies:

```js
export const scripts = pythonSources({
    root: "tools",
    sources: ["*.py"],
    resolve: project,
});
```

The resolve is synchronized from its checked-in `pyproject.toml` and `uv.lock`
without becoming the source owner. `pythonProject({ default: true })` remains
as a compatibility alias for the previous single-default-project source-run
API. Import/dependency inference and multiple project resolutions are
intentionally future work.

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
