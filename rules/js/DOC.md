# JavaScript and TypeScript rules

The JavaScript rules declare source collections and application graph roots.
Node and pnpm toolchains provide the runtime and dependency installation;
Biome adds formatting and lint facets when imported.

## Public API

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
});
```

The `registerJsSourcesHook()` and `registerJsAppHook()` exports are extension
hooks. They are not application BUILD APIs. Toolchain declarations belong to
the `//rules/js/node`, `//rules/js/pnpm`, and `//rules/js/biome` modules.
