The CMake integration is for projects whose CMake model should remain the
source of truth. `cmakeProject()` configures the project with Ninja and
discovers every real CMake target (`add_library`/`add_executable`) as a
separately selectable, separately buildable/testable child, keyed by its
CMake target name.

## Public API

Use `cmakeProject()` to import a CMake project and `cmakeLibraryDep()` to
connect a discovered target to raw C/C++ targets. Ninja parsing and expansion
helpers are implementation details.

## Declare the project root

```js
import { cmakeProject } from "//rules/c/cmake";
import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";

const project = cmakeProject({
    cmakeArgs: ["-DCMAKE_BUILD_TYPE=Release"],
});

export const my_library = {
    [BUILD]: project.get("my_library", BUILD),
    [PACKAGE]: project.get("my_library", PACKAGE),
};
export const my_test = {
    [BUILD]: project.get("my_test", BUILD),
    [TEST]: { unit: project.get("my_test", TEST, "unit") },
};
```

`path` identifies the CMake source directory (defaults to the declaring
`BUILD.js`'s own directory). `srcs` controls the files staged from that
directory, while `dirs` adds complete auxiliary directories needed by
configure or build steps. `cmakeArgs` appends project-specific options to
`cmake -S -B`.

The default `srcs` includes C and C++ files recursively. This is an explicit
CMake exception: CMake is an executable configuration language, so imp cannot
derive the complete source set from `CMakeLists.txt` without running CMake.
Use an explicit `srcs` list when the project can provide a narrower set. All
patterns still respect Git ignore rules.

Configure receives the full `srcs` input once. Before replay, imp runs a
syntax-only Ninja dependency scan over C and C++ compiler edges. Ninja reads
GCC depfiles and MSVC `/showIncludes` output, then replay gives each compiler
edge its direct source and only the workspace headers that scan found.
`extraGlobs`, `dirs`, generated CMake files, and declared `deps` stay inputs.
Link and custom edges retain the full `srcs` input because Ninja does not
state all files those commands can read.

If Ninja cannot produce a complete dependency record for one compiler edge,
imp keeps that edge correct by using the former broad include-like input set.
The action display marks this as a broad input fallback. CMake C++ module
edges that use `dyndep` are not supported yet and fail with an explicit error
when a selected target reaches one.

Use `extraGlobs` for compiler inputs with another suffix, such as generated
metadata. Use `deps` for artifact handles that CMake must see at configure
and replay time. The CMake arguments still define how CMake includes or links
those artifacts.

`cmakeProject()` returns `{get(cmakeTargetName, workflow, facet?),
all(workflow, facet?)}` — an `expand()`, not a plain object — so each
selectable target must be re-exported at the BUILD.js top level wrapped in
the usual `{[BUILD]: ..., [PACKAGE]: ..., [TEST]: {...}}` shape (a bare
`project.get(...)` call is not itself a valid export). `workflow` is one of
`BUILD`/`PACKAGE`/`TEST` (imported from `imp:core`); `TEST`'s facet is
always `"unit"`.

The toolchain a CMake project builds with is gcc-only today — pass an
explicit `toolchain: gccGraphToolchain(version)` (`//rules/c/gcc`) or rely on
the declared gcc default. Zig-as-CMake-compiler is a known, deferred gap
(zig's own graph toolchain has no named-cache-backed real path yet for
CMake to bake `CMAKE_C_COMPILER` against).

The default gcc toolchain (`//rules/c/gcc`) is a Bootlin external toolchain
whose compiler wrapper rejects any `-I`/`-isystem`/`-L` flag pointing under
`/usr/include` or `/usr/lib` ("unsafe header/library path used in
cross-compilation"), which blocks linking against host system packages (e.g.
`libwebkit2gtk-4.1` discovered via CMake's own `pkg_check_modules`). Pass
`unsafeSystemPaths: true` to bypass that guard for this project — same
toolchain sysroot, just without the check:

```js
const project = cmakeProject({
    cmakeArgs: ["-DWEBVIEW_WEBKITGTK_MODULE_NAME=webkit2gtk-4.1"],
    unsafeSystemPaths: true,
});
```

## Discovery and build execution

CMake configuration is deferred until the selected graph actually reaches
the project, and runs at most once no matter how many targets get selected
across however many goals (`expand()`'s own memoization — this is the
entire reason the graph-native rule replaced the legacy, label-based one,
which reconfigured on every single call). The generated Ninja graph is
parsed for named libraries and executables; each becomes a keyed child.
Executables referenced by `add_test()` get a `[TEST]` facet that scopes
CTest to just their correlated case(s).

```sh
imp build //native/project:my_library
imp test //native/project:my_test
```

Build execution replays reachable Ninja edges as one coarse task per
selected target (not one task per edge — see the module's own source
comments for why), so an unrelated target's rebuild doesn't force this
one's. CTest itself is always run rather than replaying a previous
successful result.

## Consuming a discovered target from raw ccLibrary()/ccBinary()

A discovered CMake target's `project.get(name, BUILD)` is a plain resolved
graph handle — unlike a raw `ccLibrary()` result, it does not itself carry
`transitiveArchives`/`transitiveSharedLibs`/`transitiveIncludeDirs`/`transitiveLinkopts`,
so a bare `project.get("mylib", BUILD)` does not work directly as a `deps`
entry. Wrap it with `cmakeLibraryDep()` instead:

```js
import { cmakeLibraryDep, cmakeProject } from "//rules/c/cmake";
import { ccBinary } from "//rules/c";

const project = cmakeProject({ path: "third_party/mylib" });

export const app = ccBinary({
    srcs: ["main.c"],
    deps: [
        cmakeLibraryDep(project, "mylib", {
            includeDirs: ["third_party/mylib/include"],
        }),
    ],
});
```

`includeDirs` is supplied by the caller rather than auto-discovered: CMake's
Ninja graph isn't parsed for per-target `-I` flags today, and even if it
were, that data is only known once the CMake configure task has actually
run — too late for `ccTask()`'s own compiler-flag construction, which needs
plain strings synchronously at `BUILD.js` declare time. This is the same
kind of manual knowledge a plain `ccLibrary({hdrs})` glob already requires.

### Shared library targets

If the CMake target is `add_library(... SHARED ...)`, say so with
`shared: true`:

```js
cmakeLibraryDep(project, "mylib", {
    includeDirs: ["third_party/mylib/include"],
    shared: true,
});
```

That routes the artifact to `transitiveSharedLibs` instead of
`transitiveArchives` — the same bucket `ccLibrary({ shared: true })` uses, so
both kinds of dep behave alike from a consumer's side. Without it a `.so`
is reported as an archive, where a consumer's `ar` step can reach it.

`shared` is caller-supplied for the same reason `includeDirs` is: the CMake
target's own type is known only once the configure task has run, while
`cmakeLibraryDep()` must report the bucket synchronously at `BUILD.js`
declare time.

A `ccBinary()` consuming a shared CMake dep both **links** and **runs**: its
product becomes a directory holding the executable plus that library, linked
with `-Wl,-rpath,$ORIGIN`, so `LD_LIBRARY_PATH` need not be set. See
`//rules/c`'s own docs for the product shape. `//rules/c/cmake/example`'s
`uses_cmake_lib_test` is the in-tree fixture that runs one.

If the CMake target is a shared library with its own shared-library
dependencies (e.g. pkg-config-discovered `libwebkit2gtk-4.1`), the final
consumer's own link step needs those flags too — the same
`unsafeSystemPaths` escape hatch (above) only fixes *this* target's own
compile/link, not what a downstream `ccBinary()`/`odinPackage()` needs to
resolve it. Supply them via `linkopts`, for the same "not structurally
discoverable" reason as `includeDirs`:

```js
cmakeLibraryDep(project, "webview", {
    includeDirs: ["third_party/webview/include"],
    linkopts: ["-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1", "-lgtk-3"],
});
```

These flow through as `transitiveLinkopts` — a `ccBinary()` consumer folds
them into its own link step automatically, and an `odinPackage()` consumer
needs `unsafeSystemPaths: true` of its own (see `//rules/odin`'s own docs)
to actually accept `-L` flags under `/usr/lib` on its own linker invocation.

## Luau modules

**Verified:** on 2026-10-13, `@imp/rules/c/cmake` has Luau modules beside the
JavaScript modules. Select the Luau workspace with `IMP_RUNTIME=luau`, as
`docs/design/luau-authoring-contract.md` describes. The C build generator
stays JavaScript.

`cmake_project(options)` and `cmake_library_dep(project, name, options)`
declare the same tasks and actions as `cmakeProject()` and
`cmakeLibraryDep()`, with the differences that the last part of this section
gives. The option and result names use `snake_case`:

| JavaScript | Luau |
| --- | --- |
| `buildDir`, `extraGlobs`, `cmakeArgs` | `build_dir`, `extra_globs`, `cmake_args` |
| `cmakeToolchain`, `unsafeSystemPaths` | `cmake_toolchain`, `unsafe_system_paths` |
| `includeDirs` | `include_dirs` |
| `transitiveArchives`, `transitiveSharedLibs` | `transitive_archives`, `transitive_shared_libs` |
| `transitiveIncludeDirs`, `transitiveLinkopts` | `transitive_include_dirs`, `transitive_linkopts` |

The other options (`path`, `srcs`, `dirs`, `deps`, `toolchain`, `linkopts`,
and `shared`) have the same names. The result of `cmake_project()` is an
expansion. Select its children with method calls:
`project:get(cmake_target_name, workflow, facet?)` and
`project:all(workflow, facet?)`. Put a `TEST` child directly in the `TEST`
slot.

**Runnable example:** `//rules/c/cmake/example/BUILD.luau` declares these
targets.

```luau
local build = require("@imp/rules/workflows/build")
local test = require("@imp/rules/workflows/test")
local cmake = require("@imp/rules/c/cmake")
local gcc = require("@imp/rules/c/gcc")
local c = require("@imp/rules/c")

local hello = cmake.cmake_project({
	path = "rules/c/cmake/example",
	cmake_args = { "-DCMAKE_BUILD_TYPE=Debug" },
})
local hello_lib = cmake.cmake_library_dep(hello, "hello_cmake", {
	include_dirs = { "rules/c/cmake/example" },
	shared = true,
})

return {
	hello_cmake_main = {
		[build.BUILD] = hello:get("hello_cmake_main", build.BUILD),
		[test.TEST] = hello:get("hello_cmake_main", test.TEST, "unit"),
	},
	uses_cmake_lib_test = c.cc_test({
		srcs = { "uses_cmake_lib.c" },
		deps = { hello_lib },
		toolchain = gcc.default_graph_toolchain(),
	}),
}
```

```sh
# From the repository root, after `cargo build -p imp`:
IMP_RUNTIME=luau target/debug/imp test //rules/c/cmake/example:hello_cmake_main //rules/c/cmake/example:uses_cmake_lib_test
```

`cmake_project_specs()` returns the declared projects in declaration order.
The C build generator uses it to find duplicate declarations.

### CMake toolchain

`@imp/rules/c/cmake/toolchain` declares CMake 4.4.3 as the default when it
loads on Linux or Windows, on x86_64 or aarch64.
`cmake_toolchain(version, options?)` declares another version. The options
are `default`, `unverified`, and `lockfile`. The result has a `GEN_LOCKFILES`
root. `graph_toolchain(version?)` returns `{ tool, version }`, and
`cmake_bin(exec, tool)` returns the absolute path of the cmake executable in
a task body.

### Differences from the JavaScript modules

- The Luau host runs one action at a time. The edges of a replay wave thus
  run one after another. Each edge still has its own action and its own
  cache entry.
- A replay action gets the tools of its task inputs: the compiler provider,
  cmake, `mkdir`, `cp`, and `dirname`. The providers have no `toolSpec(name)`.
- The configure task finds nested `CTestTestfile.cmake` files through the
  `subdirs()` entries of the top-level file.
- The Luau modules do not provide `cmakeBin()`, `installCmakeToolchain()`,
  `cmakeGraphToolSpec()`, or `cmakeGraphToolchainDir()`. `imp @cmake` does
  not dispatch to a Luau workspace.
- ctest comes from the host PATH, as in the JavaScript module, not from the
  pinned CMake toolchain.

**Unknown:** the Windows behavior of the Luau modules is not verified on a
Windows host. The fake-host tests check only the argv values.
