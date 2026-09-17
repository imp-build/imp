# Asset rules

The asset rules declare workspace files that another graph target consumes.
They keep source ownership in the graph and expose the same files to legacy
Odin and Rust rules during the migration.

## Public API

Use `asset()` for a graph-native source collection. Use `resourcePackage()` when
a legacy-compatible resource target is required. Both APIs accept workspace-
relative glob patterns and reject paths that leave the workspace.

**Illustrative example**

```js
import { asset } from "//rules/asset";

export const webAssets = asset({
    srcs: ["**/*.css", "**/*.js"],
    base: "web",
});
```

The returned `.sources` or `.files` handle stays in the graph. The asset build
does not write files into the workspace.

`ResourcePackage` and `resources` are compatibility implementation details.
Use the `resourcePackage()` function instead of constructing the class or
calling the memoized adapter directly.
