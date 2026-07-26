The C and C++ rules support two levels of integration. `ccLibrary()` and
`ccBinary()` compile explicit source targets directly, while `cmakeLib()`
imports an existing CMake/Ninja project and discovers its native targets and
CTest cases. Both paths use declared compiler and linker toolchains and expose
their artifacts to downstream native or Odin targets.

<!-- capabilities -->

## Set up a compiler

Import the C rules in `imp.workspace.js`. Raw C targets prefer the default
Zig toolchain and otherwise fall back to GCC; CMake targets use the managed
CMake default.

```js
import "//rules/c";
import "//rules/c/cmake";
import "//rules/workflows/package";
import "//rules/workflows/test";
```

Override a rule default only when needed by declaring a replacement with
`{ default: true }`, or pass a toolchain handle explicitly on one target.

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

Source and header globs are relative to `path`, which defaults to the
declaring `BUILD.js` directory. A library produces a static archive by default;
a binary links an executable. Use `output` for an explicit output path and
`linkopts` for options that belong only at link time.

```sh
imp build //native/calculator:calculator
imp package //native/calculator:calculator
```

Package products publish target artifacts below `dist/`. Dependency targets
contribute both graph ordering and link inputs; they are not loose filesystem
paths discovered from the host.

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
