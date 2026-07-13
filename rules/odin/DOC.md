The Odin rules build binaries, run test packages, validate source with
`odin check -vet`, execute a selected binary, publish artifacts, and generate
source files. Odin packages may depend on other Odin targets, resource targets,
and CMake libraries; the rule assembles the transitive sources, collection
flags, native link inputs, and managed tools needed by the sandboxed command.

<!-- capabilities -->

## Set up the workspace

Pin the compiler and formatter in `imp.workspace.js`, then load the workflows
you use:

```js
import { odinToolchain } from "//rules/odin";
import { odinfmtToolchain } from "//rules/odin/odinfmt/toolchain";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";

export const odin = odinToolchain("dev-2026-03", { default: true });
export const odinfmt = odinfmtToolchain();
```

An Odin toolchain may also select managed C linker targets. Keep that choice on
the toolchain so build, test, run, and lint resolve the same native environment.

## Declare packages and tests

```js
import { odinPackage, odinTestPackage } from "//rules/odin";

export const server = odinPackage({
    path: ".",
    output: "build/server",
});

export const server_tests = odinTestPackage({
    path: ".",
    deps: [server],
});
```

An `odinPackage` defaults to `*.odin` and excludes `*_test.odin` and
`test_*.odin`. An `odinTestPackage` includes test files and participates in the
`test` goal through `odin test`. Override `srcs` and `exclude` with globs
relative to `path` when a package uses another layout.

Set `output` when a package needs a stable workspace-relative executable path.
`package` publishes the built result below `dist/` according to the target
address. `run` executes one selected package and rejects ambiguous
multi-target selections.

```sh
imp build //apps/server:server
imp test //apps/server:server_tests
imp fmt --check //apps/server:server
imp lint //apps/server:server
imp run //apps/server:server
imp package //apps/server:server
```

## Collections

Use workspace configuration for collection names shared by many packages:

```js
export const odinConfig = {
    collections: {
        core: "src/core",
        vendor: "third_party/odin",
    },
};
```

The schema is a dynamic `map<string, string>`: collection names are not fixed
in advance, but every key and path is validated. Paths are workspace-relative.

Package-local collection entries belong on the target and override a
workspace entry with the same name:

```js
export const editor = odinPackage({
    collections: {
        generated: "generated/odin",
    },
});
```

Local collections may also use collection target handles or `{ name, path }`
entries when a plain name-to-path object is not sufficient. Collection
directories are included as declared sandbox inputs, not merely converted into
compiler flags.

## Generate sources and BUILD files

`odinGen()` declares a generated file and records the generator command or
target as a dependency. The output path is appended as the command's final
argument. Exclude that output from any overlapping `odinPackage()` glob so one
file has one owner:

```js
import { odinGen, odinPackage } from "//rules/odin";

export const bindings = odinGen({
    srcs: ["schema.json"],
    out: "generated/bindings.odin",
    cmd: ["schema-to-odin", "schema.json"],
});

export const app = odinPackage({
    exclude: ["generated/bindings.odin"],
    deps: [bindings],
});
```

Separately, `imp goal generate-build` can create declarations for unowned
Odin sources. Opt in with `odinConfig.buildGenerate: true`; it is disabled by
default.
