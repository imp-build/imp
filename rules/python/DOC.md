The Python rules model applications and pytest suites backed by a locked
`pyproject.toml` project. Applications build into self-contained PEX files;
tests create an isolated uv environment and run pytest. Ruff supplies the
format and lint products for application targets.

<!-- capabilities -->

## Set up the workspace

Declare default uv and PEX toolchains in `imp.workspace.js`. Add Ruff when
Python targets should participate in formatting and linting:

```js
import { uvToolchain } from "//rules/python/uv_toolchain";
import { pexToolchain } from "//rules/python/pex_toolchain";
import { ruffToolchain } from "//rules/python/ruff_toolchain";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/test";

export const uv = uvToolchain("0.11.16", { default: true });
export const pex = pexToolchain("2.97.1", { default: true });
export const ruff = ruffToolchain("0.15.21", { default: true });
```

Projects are built with `uv sync --frozen`. Keep `uv.lock` checked in and in
sync with `pyproject.toml`; builds and tests fail rather than resolving or
mutating a stale lock file.

## Declare an application and tests

```js
import { pythonApp } from "//rules/python";
import { pythonTest } from "//rules/python/test";

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
PEX first, and its `testArgs` are appended to `python -m pytest`. Test runs are
impure so an unchanged previous success is never replayed as the current test
result.

## Run source files

For direct script execution, declare a pinned runtime and one shallow source
set rather than an application target per file:

```js
import { pythonSources, pythonToolchain } from "//rules/python";

// imp.workspace.js
export const python = pythonToolchain("3.13.0", { default: true });

// BUILD.js
export const scripts = pythonSources({
    root: "tools",
    sources: ["*.py"],
});
```

Each direct match is lazily expanded into one `python-source` target. Run it
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
import { pythonProject } from "//rules/python";

export const project = pythonProject({ path: "python", default: true });
```

That project is synchronized from its checked-in `pyproject.toml` and
`uv.lock` without becoming the source owner. Import/dependency inference and
multiple project resolutions are intentionally future work.

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
`dist/services/acme/app`. Formatting and linting currently apply to targets
declared with `pythonApp()`; select the application target when checking the
project's Python files.
