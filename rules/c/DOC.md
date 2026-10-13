The C and C++ rules support two levels of integration. `ccLibrary()` and
`ccBinary()` build a task graph directly from declared sources, while
`cmakeProject()` (`//rules/c/cmake`) imports an existing CMake/Ninja project
and discovers separately selectable native targets and CTest cases. Both
paths use declared compiler and linker toolchains and expose their
artifacts to downstream native targets — a `ccBinary({deps: [...]})` takes
another `ccLibrary()` call's result directly, not a label reference.

<!-- capabilities -->

## Public API

The C family exposes `ccLibrary()`, `ccBinary()`, and `ccTest()` targets. The
same guide covers the CMake, GCC, mold, MSVC/NASM, and Zig toolchain modules.
Their implementation helpers and graph expansion functions are developer
reference details, not separate user APIs.

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

### Select a workspace lockfile

Each managed C toolchain (Zig, GCC, CMake, mold, NASM) ships a lockfile pinning
the download URL, size, and SHA-256 of every release artifact it knows. To pin a
version the shipped lockfile does not know, give the toolchain the address of
a lockfile this workspace owns; the shipped lockfile stays the default.

```js
import { gccToolchain } from "//rules/c/gcc";

export const gcc = gccToolchain("2024.05-1", {
	default: true,
	lockfile: "//locks/gcc.lock",
});
```

The toolchain handle is also the lockfile generation root, so write the file
with:

```sh
imp goal gen-lockfiles //:gcc
```

The generation root writes to the address the toolchain declares, so the
address is given one time only. Downloads stay verified: an address with no
file, or a lockfile with no entry for the selected version and platform, makes
the acquire fail and points at `imp goal gen-lockfiles`. `gccToolchain` also
takes an os-keyed map (`lockfile: { linux: "//locks/gcc.lock", windows:
"//locks/gcc-windows.lock" }`) to pin each platform, matching its `version`
argument.

NASM is the assembler an MSVC-driven `cmakeProject()` uses for projects that
`enable_language(ASM_NASM)` (e.g. BoringSSL). Declare `nasmToolchain` from
`//rules/c/msvc` in `imp.workspace.js`; `msvcToolchain()` picks up the default.

```js
import { nasmToolchain } from "//rules/c/msvc";

export const nasm = nasmToolchain("3.02", {
	default: true,
	lockfile: "//locks/nasm.lock",
});
```

```sh
imp goal gen-lockfiles //:nasm
```

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

The default source and header patterns match only files directly under
`path`. Use an explicit recursive pattern such as `src/**/*.c` when a target
needs nested source directories. Ignored files are never staged.

The output filename stem defaults to the directory slug. If two targets in
one directory need the same kind of artifact name, set `outputName` on each
declaration to give them distinct stems. This does not change the directory
slug used for build namespaces or the target name used by `imp package`:

```js
export const client = ccBinary({
    srcs: ["client.c"],
    outputName: "client",
});
export const server = ccBinary({
    srcs: ["server.c"],
    outputName: "server",
});
```

`outputName` is a portable filename stem. Do not include `.a`, `.so`, `.dll`
or `.exe`; the rule adds the platform-specific suffix and the `lib` prefix
for Unix shared libraries.

### Generated sources

`generatedSrcs` takes a `codegen()` result from `//rules/imp/codegen` and
stages every file it declares into the compile sandbox — a `.c`/`.cc`/`.cpp`
is compiled like any globbed source, a `.h` is mounted and resolves against
the `-I<path>` already on every compile line. `codegen()` is not
C-specific; it declares files a command writes into the graph, for any
ecosystem. Exclude a generated path from any overlapping `srcs`/`hdrs` glob
so one file has one owner:

```js
import { ccBinary } from "//rules/c";
import { codegen } from "//rules/imp/codegen";
import { nativeTool } from "//rules/imp/native-tool";
import { files } from "imp:core";

const proto = codegen({
    display: "generate protocol bindings",
    tools: { protoc: nativeTool("protoc") },
    inputs: { schema: files({ root: "app", include: ["wire.proto"] }) },
    outputPaths: ["app/generated/wire.c", "app/generated/wire.h"],
    argv: (exec, { protoc }) => [
        exec.tool(protoc, "protoc"),
        "--c_out=app/generated",
        "app/wire.proto",
    ],
});

export const app = ccBinary({
    path: "app",
    srcs: ["main.c"],
    generatedSrcs: [proto],
});
```

`outputPaths` are workspace-relative, and a nested path needs no `mkdir` —
the executor creates the parent directory of each declared output before the
program starts. The build fails if a staged artifact's real path differs
from the path its entry declared. The older explicit form,
`generatedSrcs: [{ artifact, path }]` with `path` relative to the package,
also works.

To write generated files into the workspace instead of into the graph — for
committed, drift-gated codegen — use `generatedFiles()` from
`//rules/imp/generate` and `imp generate`.

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
    <output-name>          the executable, linked with -Wl,-rpath,$ORIGIN
    lib<name>.so           every transitive shared library, under its soname
```

The executable uses `outputName` when one is supplied, or the directory slug
otherwise. The bundle directory itself remains directory-derived.

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

## Luau modules

**Verified:** on 2026-10-13, `@imp/rules/c`, `@imp/rules/c/toolchain`,
`@imp/rules/c/gcc`, `@imp/rules/c/zig`, `@imp/rules/c/msvc`,
`@imp/rules/c/mold`, and `@imp/rules/c/cmake` have Luau modules beside the
JavaScript modules. `//rules/c/cmake`'s own docs describe the CMake modules.
The C build generator stays JavaScript. Select the Luau
workspace with `IMP_RUNTIME=luau`, as
`docs/design/luau-authoring-contract.md` describes.

### Raw targets

`cc_library(options)`, `cc_binary(options)`, and `cc_test(options)` of
`@imp/rules/c` declare the same tasks and actions as `ccLibrary()`,
`ccBinary()`, and `ccTest()`, with the differences that the last part of this
section gives. The option and result names use `snake_case`:

| JavaScript | Luau |
| --- | --- |
| `generatedSrcs` | `generated_srcs` |
| `outputName` | `output_name` |
| `unsafeSystemPaths` | `unsafe_system_paths` |
| `transitiveArchives`, `transitiveSharedLibs`, `transitiveImportLibs` | `transitive_archives`, `transitive_shared_libs`, `transitive_import_libs` |
| `transitiveIncludeDirs`, `transitiveHdrs`, `transitiveLinkopts` | `transitive_include_dirs`, `transitive_hdrs`, `transitive_linkopts` |

The other options (`path`, `srcs`, `hdrs`, `deps`, `toolchain`, `copts`,
`linkopts`, and `shared`) have the same names. The results use the `BUILD`,
`PACKAGE`, `RUN`, and `TEST` slot keys of the workflow modules.
`DEFAULT_CPP_SRCS` and `DEFAULT_CPP_HDRS` are the default globs.

**Illustrative example:**

```luau
local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")

local toolchain = gcc.default_graph_toolchain()
local lib = c.cc_library({ path = "app/lib", toolchain = toolchain })

return {
	lib = lib,
	app = c.cc_binary({ path = "app", srcs = { "main.c" }, deps = { lib }, toolchain = toolchain }),
	app_test = c.cc_test({ path = "app/test", deps = { lib }, toolchain = toolchain }),
}
```

`//rules/c/graph_example/BUILD.luau` declares a library and a binary in the
same way.

`cc_workload_specs()` returns the declared targets in declaration order. The
C build generator uses it to find duplicate declarations.

### Compiler providers

`gcc.graph_toolchain(version?)`, `zig.graph_toolchain(version?)`, and
`msvc.msvc_toolchain()` return a provider table with the same fields:

| Field | Result |
| --- | --- |
| `kind` | `"gcc"`, `"zig"`, or `"msvc-host-toolchain"` |
| `task_inputs()` | The graph handles that a compile, archive, or link task declares as inputs |
| `commands(exec, inputs, options?)` | `{ env, rsp_quote, compile_command, archive_command, link_command }` |
| `cmake_configure(exec, inputs, options?)` | `{ compiler_args, env }` for a CMake configure |
| `resolves_tool_name(name)`, `resolve_state(exec, inputs)`, `edge_env(state)` | The CMake replay part of the contract |

Add the `task_inputs()` handles to the inputs of the task. In the task body,
`commands()` gives `sh -c` tokens and an `env` table for `exec.action`. The
gcc and Zig tool handles put the compiler names on PATH. The MSVC `env` puts
the MSVC and Windows SDK `bin` directories of the host on PATH, and sets
`INCLUDE` and `LIB`. The `unsafe_system_paths` option of gcc `commands()`
and `cmake_configure()` selects the compilers that skip the Bootlin path guard.

`toolchain.cc_toolchain_for_platform({ linux = ..., windows = ... })` returns
a union. `toolchain.select_cc_toolchain(value, platform?)` returns the
provider of the host OS, or of `platform`. A branch can be a function that
returns a provider.

The Zig provider has no CMake support: its `cmake_configure` fails, and
`resolves_tool_name` is false.

**Illustrative example:**

```luau
local core = require("@imp/core")
local gcc = require("@imp/rules/c/gcc")

local provider = gcc.graph_toolchain()
local inputs = provider.task_inputs()
inputs.sh = core.native_tool("sh")

local compile = core.task({
	inputs = inputs,
	run = function(exec, resolved)
		local commands = provider.commands(exec, resolved)
		-- Join commands.compile_command({ ... }) into an `sh -c` script, and
		-- give commands.env to exec.action.
	end,
})
```

### Declare toolchain versions

Each module declares its pinned default when it loads on a platform that it
supports: gcc 2025.08-1 on Linux x86_64 and 16.2.0posix-14.0.0-ucrt-r1 on
Windows x86_64, Zig 0.16.0 on Linux and Windows, and NASM 3.02 and mold
2.42.1 on their only platforms. The JavaScript gcc and Zig modules fail to
load on another platform. The Luau modules declare no default there.

`gcc_toolchain(version, options?)`, `zig_toolchain(version, options?)`,
`nasm_toolchain(version?, options?)`, and `mold_toolchain(version, options?)`
declare another version. The options are `default`, `unverified`, and
`lockfile`. gcc takes a version and a lockfile address for each OS, for
example `{ linux = "2025.08-1", windows = "16.2.0posix-14.0.0-ucrt-r1" }`.
The result has a `GEN_LOCKFILES` root, so a BUILD module can export it for
`imp goal gen-lockfiles`. A lockfile address must start with `@workspace/` or
`@imp/rules/`.

### Absolute host paths

Some programs need an absolute path, for example a rustc linker or a path
that CMake writes into build.ninja. These functions take the task `exec` and
a tool handle that the task declares as an input:

- `gcc.rust_link_driver_env(exec, tool, kache_active)` returns
  `{ rustflags, env, path_dirs }`.
- `gcc.cmake_compiler_args(exec, tool, unsafe_system_paths?)` and
  `gcc.windows_runtime_archives(exec, tool, version)` return argument lists.
- `msvc.resolve_nasm_host(exec, nasm_tool)` returns the path of nasm.exe.
- `mold.rust_linker_env(exec, tool)` returns `{ rustflags, path_dirs }`, and
  `mold.odin_linker_env(exec, tool)` returns `{ flags, path_dirs }`.

### Differences from the JavaScript modules

- `cc_library`, `cc_binary`, and `cc_test` always compile with the debug
  flags. The Luau host has no mode axes yet, so a task cannot read the `opt`
  axis. `--profile` and `--axis` do not change these targets.
- The Luau host runs one action at a time. The compile actions of a target
  thus run one after another. Each source still has its own action and its
  own cache entry.
- The Luau modules do not provide `installGccToolchain()`,
  `installZigToolchain()`, `gccTool()`, `gccBin()`, `zigBin()`,
  `nasmHostBin()`, `nasmGenLockfiles()`, `installMoldToolchain()`,
  `moldTool()`, or `moldBin()`. `imp @gcc`, `imp @zig`, `imp @nasm`, and
  `imp @mold` do not dispatch to a Luau workspace.
- The providers have no `toolSpec(name)`. A CMake replay edge finds the gcc
  names through the tool handle, and the MSVC names through the PATH of the
  provider `env`.
- The MSVC provider does not copy the host `bin` directories into named
  caches. It runs the host programs where Visual Studio installed them.
- The Zig build cache is shared by each workspace on the computer. The
  JavaScript module keeps it in the workspace scope. Zig locks its cache
  entries, so concurrent writers are safe.
- The NASM named cache has a key for each version. The JavaScript module uses
  one fixed key, `default`, for all versions.
- On Windows, the gcc install script runs `mkdir`, `cp`, `mv`, and `unzip`
  by name. The JavaScript module gives their absolute paths.

**Unknown:** the Windows behavior of the Luau modules is not verified on a
Windows host. The fake-host tests check only the argv and environment
values. These points need a real host:

- The gcc, Zig, and NASM install scripts that run tools by name.
- The MSVC `PATH` value `C:/...;C:/...`, after the `sh` of Git for Windows
  converts it.
- A CMake replay edge that runs a bare `rc` or `mt` through that `PATH`.

To verify, run `IMP_RUNTIME=luau imp build` on Windows for a task that
compiles and links a C source with `gcc.graph_toolchain()`,
`zig.graph_toolchain()`, and `msvc.msvc_toolchain()`.
