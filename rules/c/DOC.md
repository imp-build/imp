The C and C++ rules support two levels of integration. `ccLibrary()` and
`ccBinary()` compile explicit source targets directly, while `cmakeLib()`
imports an existing CMake/Ninja project and discovers its native targets and
CTest cases. Both paths use declared compiler and linker toolchains and expose
their artifacts to downstream native or Odin targets.

<!-- capabilities -->

## Set up a compiler

Register a default compiler toolchain in `imp.workspace.js`. Raw C targets
prefer a default Zig toolchain and otherwise fall back to GCC; CMake targets
also need their managed CMake toolchain.

```js
import "//rules/c";
import "//rules/c/cmake";
import { gccToolchain } from "//rules/c/gcc/toolchain";
import { cmakeToolchain } from "//rules/c/cmake/toolchain";
import "//rules/workflows/package";
import "//rules/workflows/test";

export const gcc = gccToolchain("2025.08-1", { default: true });
export const cmake = cmakeToolchain("3.31.0", { default: true });
```

Versions are examples; use versions available for the platforms your
workspace supports. A target can override the default by passing a toolchain
handle explicitly.

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
