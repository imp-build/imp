# Asset rules

Declare workspace source files as graph handles. The asset build captures
files without writing build products into the workspace.

## Public API

`asset({ srcs, base?, path?, exclude? })` returns `sources` and a BUILD root.
`resource_package(options)` also exposes the source handle as `files` for
resource dependencies. Paths must stay within the workspace.

**Illustrative example**

```luau
local asset = require("@imp/rules/asset")
return {
    web_assets = asset.asset({ base = "web", srcs = { "**/*.css", "**/*.js" } }),
}
```

Use the returned handles in task inputs. Declare tools separately. Asset
ownership follows the selected source globs and the workspace ignore rules.
