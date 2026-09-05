The C and C++ rules support two levels of integration. `ccLibrary()` and
`ccBinary()` build a task graph directly from declared sources, while
`cmakeProject()` (`//rules/c/cmake`) imports an existing CMake/Ninja project
and discovers separately selectable native targets and CTest cases. Both
paths use declared compiler and linker toolchains and expose their
artifacts to downstream native targets — a `ccBinary({deps: [...]})` takes
another `ccLibrary()` call's result directly, not a label reference.

<!-- capabilities -->

## Set up a compiler

Import the C rules in `imp.workspace.js`. Raw C targets prefer the default
Zig toolchain and otherwise fall back to GCC; CMake targets build with GCC
only (see `//rules/c/cmake`'s own docs for the zig gap).

```js
import "//rules/c";
import "//rules/c/cmake";
import "//rules/workflows/package";
import "//rules/workflows/test";
```

Override a rule default only when needed by declaring a replacement with
`{ default: true }`, or pass a toolchain handle explicitly on one target —
`gccGraphToolchain(version)`/`zigGraphToolchain(version)` (`//rules/c/gcc`,
`//rules/c/zig`), not the legacy per-rule toolchain classes.

This repository's workspace imports `//rules/imp/mode`. Its `default`
profile builds raw C/C++ with `-O0 -g` and configures CMake with
`CMAKE_BUILD_TYPE=Debug`; `--profile release` uses `-O2 -DNDEBUG` and
`CMAKE_BUILD_TYPE=Release`. Target `copts` and `cmakeArgs` are appended after
those defaults and can override them for one target.

## Declare raw targets

```js
import { ccLibrary, ccBinary } from "//rules/c";

export const math = ccLibrary({
    srcs: ["math.c"],
    hdrs: ["math.h"],
});

export const calculator = ccBinary({
    srcs: ["main.c"],
    deps: [math],
    copts: ["-Wall", "-Wextra"],
});
```

Source and header globs are evaluated relative to `path`, which defaults
to the declaring `BUILD.js` directory. A library produces a static archive;
a binary links an executable. `deps` takes other `ccLibrary()` call results
directly (handle-passing), which the target's own
`transitiveArchives`/`transitiveSharedLibs`/`transitiveIncludeDirs`/`transitiveLinkopts`
fold in automatically — not a loose filesystem path or label reference. A discovered
CMake target needs wrapping with `cmakeLibraryDep()` (`//rules/c/cmake`)
first — see its own docs. Use `linkopts` for options that belong only at
this target's own link step (not propagated to anything depending on it —
use a dep's `transitiveLinkopts` for flags a consumer needs, e.g. a shared
library's own `-L`/`-l` dependencies).

### Static archives and shared libraries

`ccLibrary()` produces a static `.a` archive by default and reports it as
`transitiveArchives`. With `shared: true` it produces a `lib<name>.so`
(`<name>.dll` on Windows, which uses no `lib` prefix) and reports it as
`transitiveSharedLibs` instead. The two buckets
stay separate because the two kinds of file need different handling: an
archive is fed both to `ar` and to the linker, while a shared library is
only ever fed to the linker. A consumer folds in both automatically, so
either kind of dep links without the caller doing anything.

```js
export const plugin = ccLibrary({
    srcs: ["plugin.c"],
    shared: true,
});

export const host = ccBinary({
    srcs: ["main.c"],
    deps: [plugin],
});
```

A discovered CMake target must state which kind it is —
`cmakeLibraryDep(project, "mylib", { shared: true })`, see `//rules/c/cmake`'s
own docs.

The filename is not decoration. A shared library is linked with
`-Wl,-soname,lib<name>.so`, so a consumer records that bare name in its own
`DT_NEEDED` entry and the loader can answer it from a search path. Without a
soname the linker records the library's build path instead, and a `DT_NEEDED`
holding a slash makes the loader skip its search paths entirely. `imp package`
publishes a shared library under this same filename rather than under the
target name, for the same reason — so a packaged library and a packaged
consumer in one directory resolve against each other.

### A binary's product carries its shared libraries

A binary that links a workspace-built shared library needs that library beside
it at run time, so its product is a **directory** rather than a single file:

```
dist/<package>/<target>/
    <target-slug>          the executable, linked with -Wl,-rpath,$ORIGIN
    lib<name>.so           every transitive shared library, under its soname
```

`$ORIGIN` is expanded by the loader to the directory holding the executable,
which is where the libraries are, so the binary runs with `LD_LIBRARY_PATH`
unset — under `imp run`, under `imp test`, from `dist/` after `imp package`,
and when invoked directly. Both halves are needed: staging without the rpath
gives the loader no reason to look beside the executable, and the rpath
without staging points at a directory holding no library.

A binary with **no** shared dependency keeps the single-file product it has
always had at `dist/<package>/<target>`. Nothing has to travel beside it, so
nothing changes.

Windows is unverified. A `.dll` beside the executable is found by the default
search order and there is no rpath concept, so the copy alone should suffice
there; the rpath argument is omitted on Windows and by MSVC.

### Running and testing a binary

`ccBinary()` exposes a `[RUN]` root, so `imp run //pkg:target` launches the
built executable (a bundled one through its own product directory). `ccTest()`
takes every `ccBinary()` option and adds a `[TEST]` root that runs the
executable and reports its exit code as one test unit — the same granularity
`//rules/c/cmake` reports for a CTest entry. The assertion belongs inside
`main()`:

```js
export const adds_test = ccTest({
    srcs: ["adds_test.c"],   // int main(void) { return add(2, 3) == 5 ? 0 : 1; }
    deps: [mathlib],
});
```

The default GCC toolchain (`//rules/c/gcc`) is a Bootlin external toolchain
whose compiler wrapper rejects any `-I`/`-isystem`/`-L` flag pointing under
`/usr/include` or `/usr/lib` ("unsafe header/library path used in
cross-compilation"), which blocks linking against host system packages. Pass
`unsafeSystemPaths: true` to bypass that guard for one target — same
toolchain sysroot, just without the check (no-op on the Zig toolchain, which
has no such guard):

```js
export const webview = ccLibrary({
    srcs: ["webview.c"],
    copts: ["-isystem", "/usr/include/webkitgtk-4.1"],
    unsafeSystemPaths: true,
});
```

```sh
imp build //native/calculator:calculator
imp package //native/calculator:calculator
```

`ccLibrary()`/`ccBinary()` expose `[BUILD]`/`[PACKAGE]` directly on their
returned object — no separate export-wrapping needed, unlike a discovered
CMake target (see `//rules/c/cmake`'s own docs).

For bespoke builds outside this model entirely, declare a label in the
BUILD file and attach `build()`, `test()`, or `packageGoal()` handlers
directly — the legacy, pre-graph-native escape hatch, still supported for
builds that don't fit `ccLibrary()`/`ccBinary()`'s shape.

## Generate declarations

The C build generator scans unowned CMake and C/C++ sources and writes
appropriate declarations. Enable it explicitly:

```js
export const cConfig = {
    buildGenerate: true,
};
```

Then run `imp goal generate-build`. Generation is opt-in so repositories with
custom ownership or mixed build layouts are not rewritten unexpectedly.
