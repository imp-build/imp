The CMake integration is for projects whose CMake model should remain the
source of truth. `cmakeProject()` configures the project with Ninja and
discovers every real CMake target (`add_library`/`add_executable`) as a
separately selectable, separately buildable/testable child, keyed by its
CMake target name.

## Declare the project root

```js
import { cmakeProject } from "//rules/c/cmake";
import { BUILD, PACKAGE, TEST } from "imp:core";

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

## Known gap: raw ccLibrary()/ccBinary() interop

A discovered CMake target's `project.get(name, BUILD)` is a plain resolved
graph handle — unlike a raw `ccLibrary()` result, it does not also carry
`transitiveArchives`/`transitiveIncludeDirs`, so `ccBinary({deps:
[project.get("mylib", BUILD)]})` does not work transparently yet. Tracked as
a follow-up (see the repo's own issue tracker); not solved by this rule.
