The CMake integration is for projects whose CMake model should remain the
source of truth. `cmakeProject()` configures the project with Ninja and
discovers every real CMake target (`add_library`/`add_executable`) as a
separately selectable, separately buildable/testable child, keyed by its
CMake target name.

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

Configure receives the full `srcs` input once. During replay, C/C++ compiler
edges receive their direct source, all captured include-like files (`.h`,
`.hpp`, `.inc`, and related suffixes), `extraGlobs`, `dirs`, generated CMake
files, and declared `deps`. Link and custom edges retain the full `srcs`
input because Ninja does not state all files those commands can read.

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
`transitiveArchives`/`transitiveIncludeDirs`/`transitiveLinkopts`, so a bare
`project.get("mylib", BUILD)` does not work directly as a `deps` entry.
Wrap it with `cmakeLibraryDep()` instead:

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
