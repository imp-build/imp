The Odin rules build binaries, run test packages, validate source with
`odin check -vet`, execute a selected binary, publish artifacts, and generate
source files. Odin packages may depend on other Odin targets, resource targets,
and CMake libraries; the rule assembles the transitive sources, collection
flags, native link inputs, and managed tools needed by the sandboxed command.

<!-- capabilities -->

## Set up the workspace

Import the compiler and formatter rules in `imp.workspace.js`, then load the
workflows you use. The rules provide pinned defaults:

```js
import "//rules/odin";
import "//rules/odin/odinfmt";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";

```

Override a default only when needed, for example to select a managed linker.
Keep that choice on the Odin toolchain so build, test, run, and lint resolve
the same native environment.

This repository's workspace imports `//rules/imp/mode`: the default profile
keeps Odin's `-debug` build behavior, while `imp build --profile release ...`
uses Odin's `-o:speed` optimization mode.

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
`test_*.odin`. An `odinTestPackage` defaults to exactly those two globs and
participates in the `test` goal through `odin test`. The two defaults are
mirror images, so tests beside the code need no `srcs` on either target.
Override `srcs` and `exclude` with globs relative to `path` when a package uses
another layout.

Odin compiles a directory as one package, so a test package that shares its
directory with the package under test cannot link against it — it is the same
package, compiled with its test files. That is what the `deps: [server]` above
does: the two source sets land at the same sandbox path and `odin test` sees
one package. The ordinary sources stay declared one time, rather than in a
second glob to keep in sync by hand.

A directory that holds only tests needs no such dep — it is an ordinary
package that happens to be all tests. Give it `srcs` when its files do not
carry the test suffix, or the default glob matches nothing.

`imp lint --fix` is accepted goal-wide but has no effect for Odin packages:
`odin check -vet` has no autofix mode, so `--fix` just runs the same plain
lint.

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
compiler flags: the rule walks the package's imports transitively and declares
every directory it reaches, whether that directory is a declared
`odinPackage()` or an undeclared tree such as a vendored library. Only the
collections those imports actually use become `-collection:` flags. An import
that resolves to a workspace path with no Odin package behind it fails the
build with the importing package and the resolved path, rather than reaching
the compiler as a broken collection flag.

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

A package's `generatedSrcs` follow it through the source closure, like its
native deps: declare a generated source on the package that owns it, and every
package that reaches it gets the file staged. Two packages may name the same
artifact at the same workspace path — that is one input — but two different
artifacts claiming one path is a declaration error, since one would overwrite
the other in the sandbox.

Separately, `imp goal generate-build` can create declarations for unowned
Odin sources. Opt in with `odinConfig.buildGenerate: true`; it is disabled by
default.

## Native (`ccLibrary`/CMake) dependencies

`deps` also accepts a raw `ccLibrary()` result, or a `cmakeLibraryDep()`
adapting a CMake target (see `//rules/c`, `//rules/c/cmake`). Its built
archive is staged into the sandbox at its real workspace-relative path, so a
`foreign import` can reference it directly — resolved, per the Odin
compiler, relative to the importing `.odin` file's own directory:

```js
import { ccLibrary } from "//rules/c";
import { odinPackage } from "//rules/odin";

export const sqlite = ccLibrary({ path: "vendor/sqlite" });

export const app = odinPackage({
    deps: [sqlite],
});
```

```odin
// app.odin (at the odinPackage's own path "."): ccLibrary()'s archive
// always lands at "build/c/<slug>.a", workspace-root-relative regardless of
// the library's own path — adjust the "../" prefix for the importing
// package's own directory depth.
foreign import sqlite "build/c/vendor_sqlite.a"
```

A native dep belongs to the package whose own source names it. One `odin build`
compiles the whole import closure, so an archive that any package in that
closure needs is staged for the compilation — and a package inherits the
archives and `transitiveLinkopts` of every Odin package it reaches, whether by
`deps` or by a bare `import`. Declare a native dep one time, on the package
whose `foreign import` names it; consumers declare only what their own sources
need.

`deps` also takes a plain graph handle — a `files()` set of fixture data, a
task output — and stages it into the sandbox as it is:

```js
const test_pem = files({ include: ["testdata/*.pem"] });

export const client_tests = odinTestPackage({ deps: [client, test_pem] });
```

A dep of no recognized shape is a declaration error. It would otherwise
contribute nothing, which reads the same as never declaring it, and shows up
as a missing file much later.

`unsafeSystemPaths` is the one thing that does **not** travel that path. It
bypasses a guard, so every package states its own — the same rule `//rules/c`
already applies to `ccLibrary()` and `ccBinary()`.

A dep's own `transitiveLinkopts` (e.g. a `cmakeLibraryDep({linkopts: [...]})`
wrapping a shared library that itself depends on host system packages) fold
into the final `odin build`'s own linker invocation automatically, as a
single `-extra-linker-flags:` argument. The default GCC toolchain
(`//rules/c/gcc`) is a Bootlin external toolchain whose compiler wrapper
rejects any `-L` flag pointing under `/usr/lib` — since Odin links via that
same toolchain, pass `unsafeSystemPaths: true` on the `odinPackage()` itself
to bypass that guard for its own linker invocation (independent of, and in
addition to, `unsafeSystemPaths` on any `ccLibrary()`/`cmakeProject()` dep —
see `//rules/c`'s own docs):

```js
import { cmakeLibraryDep, cmakeProject } from "//rules/c/cmake";
import { odinPackage } from "//rules/odin";

const project = cmakeProject({ path: "third_party/webview", unsafeSystemPaths: true });

export const app = odinPackage({
    deps: [
        cmakeLibraryDep(project, "webview", {
            includeDirs: ["third_party/webview/include"],
            linkopts: ["-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1", "-lgtk-3"],
        }),
    ],
    unsafeSystemPaths: true,
});
```
