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
