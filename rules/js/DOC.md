# JavaScript and TypeScript rules

The JavaScript rules declare source collections and application graph roots.
Node and pnpm toolchains provide the runtime and dependency installation;
Biome adds formatting and lint facets when imported.

## Public API

### Luau API

For BUILD authors, `@imp/rules/js` exports `js_sources`, `js_app`, and
`ts_app`. Use `imp.workspace.luau` and select it with `IMP_RUNTIME=luau`.
The JavaScript modules remain available while the catalog migration is in
progress. The generated API references still describe JavaScript. Luau
reference extraction belongs to the workspace and documentation integration
task.

**Illustrative example**

In `imp.workspace.luau`, register the workflows:

```lua
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/lockfiles")
return {}
```

In `BUILD.luau`, declare toolchain targets and an application:

```lua
local js = require("@imp/rules/js")
local node = require("@imp/rules/js/node").node_toolchain("26.8.2", { default = true })
local pnpm = require("@imp/rules/js/pnpm").pnpm_toolchain("12.4.1", { default = true })
return {
    node = node,
    pnpm = pnpm,
    app = js.ts_app({ src = "app", entry = "index.js", sources = { "src/**/*.ts" } }),
}
```

From the workspace root, run `IMP_RUNTIME=luau imp build //:app`, then
`IMP_RUNTIME=luau imp run //:app -- argument`. An application needs a
`package.json` and `pnpm-lock.yaml`. TypeScript applications also need a
TypeScript dependency and `tsconfig.json` with `outDir` set to `dist`. A
TypeScript entry is relative to `dist`; a JavaScript entry is relative to
the application directory.

Both application factories accept `src`, `base`, `sources`, `entry`,
`node_version`, and `pnpm_version`. The version options accept version strings
or graph tool handles. Source patterns are relative to the application root.
`base` defaults to the BUILD package; `src` defaults to `.`. Source defaults
include direct `.js`, `.jsx`, `.ts`, and `.tsx` files. Nested source directories
need explicit patterns. Public results are frozen tables with `sources`,
`root`, `BUILD`, and `RUN` fields. `js_sources` accepts `base` and `src` and
returns `sources`, `root`, and `BUILD`. Its build task captures the source
digest; use `sources` as the file input for another task.

Install uses only the manifest and lockfile. Source edits do not invalidate
that action. Build outputs remain in the CAS. Run stages sources, installed
dependencies, and compiled output in a sandbox. It passes CLI arguments to
Node and reports program failure. Neither build nor run writes `node_modules`
or `dist` into the workspace. Application actions use POSIX shell tools;
Windows application execution is unverified.

`register_js_sources_hook` and `register_js_app_hook` are extension APIs. Each
hook receives a frozen snapshot and returns additional fields. Hooks run in
registration order; registering the same function twice does not add it twice.
Import an extension before declaring targets that need its facets. The Luau
Biome extension belongs to a separate migration task.

#### Toolchains and lockfiles

`node_toolchain(version, options)` and `pnpm_toolchain(version, options)`
return `version`, `lockfile`, and a `GEN_LOCKFILES` root. Options are `default`,
`lockfile`, and `unverified`. Imports select Node `26.8.2` and pnpm `12.4.1`
as defaults; explicit default declarations replace them. Lockfiles ship with
Imp. Set `lockfile` to an `@workspace/...` address to use a workspace file.
A missing file or entry fails acquisition with a regeneration hint.
`unverified = true` permits an unverified download and logs a warning.

**Warning:** Lockfile generation writes the selected files into the workspace.

With the toolchain targets in the example, run
`IMP_RUNTIME=luau imp goal gen-lockfiles //:node //:pnpm` from the workspace
root. Existing locked versions remain in the generated lockfile.

For rule authors, each module exports `graph_toolchain(version)`, which returns
`tool` and `version`. Declare the tool as a task input. Within the callback,
`node_bin(exec, tool)` or `pnpm_bin(exec, tool)` returns an absolute executable
path. Luau omits local-cache imports, legacy run descriptors, and `imp @tool`
dispatch. Node preserves Linux and macOS x86_64/aarch64 and Windows x86_64
mappings. pnpm preserves Linux x86_64/aarch64, macOS aarch64, and Windows
x86_64/aarch64 mappings; it has no Intel macOS artifact.

pnpm also exports `store_tool()` and `store_env(exec, cache)`. Declare the
store tool as an input before requesting its absolute environment settings.
The shared `pnpm-store/shared` cache is seeded once and has empty `bin_dirs`,
so it does not enter `PATH`. Application install does not use this optional
shared store.

### JavaScript API

Use `jsSources()` for a shallow source collection, `jsApp()` for a JavaScript
application, and `tsApp()` for a TypeScript application. An application needs
`package.json` and a frozen pnpm lockfile. A TypeScript application also needs
`tsconfig.json` with `outDir: "dist"` and a TypeScript dependency.

**Illustrative example**

```js
import { tsApp } from "//rules/js";

export const app = tsApp({
    src: "app",
    entry: "main.js",
    sources: ["src/**/*.ts"],
});
```

Application source patterns default to direct JavaScript and TypeScript files
under the app root. Declare nested directories explicitly with patterns such as
`src/**/*.js` or `src/**/*.ts`; ignored files are never staged.

The `registerJsSourcesHook()` and `registerJsAppHook()` exports are extension
hooks. They are not application BUILD APIs. Toolchain declarations belong to
the `//rules/js/node`, `//rules/js/pnpm`, and `//rules/js/biome` modules.
