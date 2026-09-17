# Zola rules

The Zola rules acquire a pinned Zola release as a graph tool. Imp uses this
tool to build the documentation site. A workspace may declare another locked
version when the shipped lockfile does not contain the required release.

## Public API

Use `zolaToolchain(version, options)` to declare the workspace toolchain and
optionally make it the default. `zolaGraphTool()` is the graph-native tool
handle used by build rules. `zolaBin()` and the artifact/download helpers are
toolchain implementation helpers, not user BUILD APIs.

**Illustrative example**

```js
import { zolaToolchain } from "//rules/zola";

export const zola = zolaToolchain("0.22.1", { default: true });
```

The toolchain uses the checked-in lockfile and supports the platforms listed by
the current release map. Use `zolaGraphTool()` only from a rule that needs a
graph tool input.
