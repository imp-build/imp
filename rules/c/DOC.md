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
`transitiveArchives`/`transitiveIncludeDirs` fold in automatically — not a
loose filesystem path or label reference. A discovered CMake target needs
wrapping with `cmakeLibraryDep()` (`//rules/c/cmake`) first — see its own
docs. Use `linkopts` for options that belong only at link time.

```sh
imp build //native/calculator:calculator
imp package //native/calculator:calculator
```

`ccLibrary()`/`ccBinary()` expose `[BUILD]`/`[PACKAGE]` directly on their
returned object — no separate export-wrapping needed, unlike a discovered
CMake target (see `//rules/c/cmake`'s own docs).

For bespoke builds outside this model entirely, declare a label in the
BUILD file and attach `build()`, `test()`, or `packageGoal()` handlers
directly — the legacy, pre-graph-native escape hatch. The
`//rules/c/label_example:hasher` fixture demonstrates this shape using
ordinary memoized compile and link functions.

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
