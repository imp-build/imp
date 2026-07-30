The CMake integration is for projects whose CMake model should remain the
source of truth. A `cmakeLib()` label configures the project with Ninja and
then discovers separately selectable libraries,
executables, and CTest-backed tests.

## Declare the project root

```js
import { cmakeLib } from "//rules/c/cmake";
import { zigToolchain } from "//rules/c/zig";

const compiler = zigToolchain("0.16.0");

export const project = cmakeLib({
    compiler,
    cmakeArgs: ["-DCMAKE_BUILD_TYPE=Release"],
});
```

`src` identifies the CMake source directory. `srcs` controls the files staged
from that directory, while `dirs` adds complete auxiliary directories needed
by configure or build steps. `cmakeArgs` and `ctestArgs` append project-specific
options to their respective tools.

For a hand-written coarse target, list expected `outputs` relative to the
source directory. `stageOutputs` can copy explicitly named files to other
workspace paths, but such scattered outputs cannot currently be packaged as
one `dist/` artifact.

## Lazy label discovery

CMake configuration is deferred until the selected graph reaches the project.
The generated Ninja graph is inspected for named libraries and executables;
each becomes an imp label in the same address scope. Executables referenced
by `add_test()` receive test handlers that run the correlated CTest cases. The
parent `cmakeLib` label can still run the
whole CTest suite.

```sh
# Build the coarse declaration.
imp build //native/project:project

# Build or test a target discovered from CMake's generated graph.
imp build //native/project:my_library
imp test //native/project:my_test
```

Build execution replays reachable Ninja edges as imp tasks, allowing
unchanged compile edges to remain cache hits instead of treating the entire
CMake build as one opaque command. CTest itself is always run rather than
replaying a previous successful result.

## Consuming native outputs

A CMake target can be used as a dependency by raw C/C++ or Odin targets. Its
link artifacts and output digest are passed through the build graph even when
the intermediate build directory is not materialized in the source workspace.
Use `outputs` to make hand-written target artifacts discoverable to these
consumers.
