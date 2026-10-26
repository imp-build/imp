# Quality checks for Imp Luau modules

For Imp rule authors and contributors. Declare format and lint roots for
workspace modules, BUILD modules, rules, and tests. These rules target Imp
sources. They do not provide a general Lua application or type-checking API.

## Declare sources and tools

**Runnable example**

From a workspace root, put this in `imp.workspace.luau`:

```luau
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
local luau = require("@imp/rules/imp/luau")
luau.stylua_toolchain("2.6.0", { default = true })
luau.luau_analyzer_toolchain("0.709", { default = true })
return {}
```

Put this in `BUILD.luau`:

```luau
local luau = require("@imp/rules/imp/luau")
return { authoring = luau.luau_sources({ srcs = { "*.luau" } }) }
```

Run `imp fmt //:authoring`, `imp fmt //:authoring --check`, and
`imp lint //:authoring`. Check mode fails when formatting differs and does not
write workspace sources. Lint reports source locations and fails on analyzer
errors. `imp lint --fix` runs analysis but does not apply fixes.

`luau_sources({ srcs, base?, exclude? })` requires non-empty source patterns.
Patterns are relative to `base`, which defaults to the declaring package.
The frozen result exposes `sources`, FMT, and LINT roots. Select only Luau files.

## Configuration and toolchains

The actions capture workspace-root `.stylua.toml` or `stylua.toml` and
`.luaurc`. Nested configuration files and EditorConfig files are not captured.
Keep configuration at the workspace root. StyLua always uses Luau syntax.
To use lint without type checking, put this in `.luaurc`:

```json
{
  "languageMode": "nocheck",
  "lintErrors": true
}
```

Without this configuration, the analyzer uses its own type-checking and lint
defaults. The rules do not resolve Imp host API types for the analyzer.

Both toolchain declarations accept `default`, `lockfile`, and `unverified`
options. Lockfile addresses start with `@imp/` or `@workspace/`. Downloads use
SHA-256 locks and graph tool handles. Export a declaration to select its
GEN_LOCKFILES root with `imp goal gen-lockfiles`. The repository's
`imp goal gen-builtin-lockfiles` includes both shipped locks.

StyLua 2.6.0 has archives for Linux x86_64 and arm64, macOS x86_64 and arm64,
and Windows x86_64. Analyzer 0.709 has archives for Linux x86_64, macOS arm64,
and Windows x86_64. Other combinations fail explicitly. The rules do not build
from source or use emulation. Native execution has been checked on Linux
x86_64 only.
