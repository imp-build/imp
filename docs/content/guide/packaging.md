+++
title = "Package build outputs"
weight = 20
extra = { sidebar_heading = true }
+++

This page is for users who need to publish a build result or create an OCI
image. `imp package` writes selected package results below `dist/`; it does not
publish them to a registry or deployment system by itself.

## Package a target

Declare a package-capable target in a `BUILD.js` file, then select it from the
workspace root:

**Illustrative example**

```sh
imp package //apps/server:server
```

The output is placed below `dist/` according to the target address. Read the
target's rule guide to find the exact output shape. Package output
is separate from the graph and cache: changing or deleting `dist/` does not
change the cached graph result.

## Export graph-generated files

Use `imp codegen` to inspect outputs from selected `codegen()` declarations.
The declaration must be exported from its `BUILD.js` file:

**Illustrative example**

```js
import { codegen } from "//rules/imp/codegen";

export const bindings = codegen({
    outputPaths: ["app/generated/bindings.odin"],
    // Declare the generator's tools, inputs, and argv.
});
```

For a Luau workspace, return the declaration from `BUILD.luau`. Require
`@imp/rules/workflows/codegen` in `imp.workspace.luau` to register the goal.

**Illustrative example**

```lua
local core = require("@imp/core")
local codegen = require("@imp/rules/imp/codegen").codegen

return {
    bindings = codegen({
        tools = { generator = core.native_tool("my-generator") },
        output_paths = { "app/generated/bindings.odin" },
        argv = function()
            return { "my-generator", "--output", "app/generated/bindings.odin" }
        end,
    }),
}
```

Replace `my-generator` and its arguments with your generator command. If the
workspace has both runtime configuration files, set `IMP_RUNTIME=luau`.

From the workspace root, select that exported value:

**Illustrative example**

```sh
imp codegen //app:bindings
```

Imp writes the output to `dist/codegen/app/generated/bindings.odin`. This
workflow leaves `codegen()` outputs in the graph for package consumers and
publishes a copy under `dist/codegen/` when selected. Use `imp generate` for
files that belong in the workspace and must stay up to date with a drift check.
Use `imp package` for a target's package result. `imp codegen` does not remove
files from `dist/codegen/` that are not part of the current selection.

## Build an OCI image

The OCI rules build images without requiring a Docker daemon. Use
`ociPull()` or `ociBuild()` for the image, then `ociPush()` or `ociMirror()` for
registry movement. The [OCI user API reference](../../reference/user-api/) documents
the required repository, tag, digest, and credential behavior.

Prefer an immutable base digest when reproducibility matters. A tag can move,
so a later run may resolve a different base image.

## Deployment boundary

Imp can produce files and OCI images for another system to deploy. It does not
decide deployment policy, rollout order, service identity, or production
credentials. Keep those controls in the deployment system and pass only the
artifact that system is intended to consume.
