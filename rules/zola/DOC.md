# Zola rules

For BUILD authors, the Zola rules acquire a pinned Zola release as a graph
tool. Declare the tool as a task input to build a site in a sandbox. The
Luau default is `0.23.6`; the shipped lockfile also contains `0.22.1`.

## Public API

Use `imp.workspace.luau` and select Luau with `IMP_RUNTIME=luau`. Register
`@imp/rules/workflows/lockfiles` in that workspace module when you need the
`gen-lockfiles` goal.

**Illustrative example** — export this declaration from `BUILD.luau`:

```lua
local zola = require("@imp/rules/zola")

return {
    zola = zola.zola_toolchain("0.23.6", {
        default = true,
        lockfile = "@workspace/locks/zola.lock",
    }),
}
```

From that workspace root, run
`IMP_RUNTIME=luau imp goal gen-lockfiles //:zola` to write
`locks/zola.lock`. Omit `lockfile` to acquire from the lockfile shipped with
Imp. A workspace file does not replace a shipped lockfile implicitly.
Missing lock entries fail acquisition and name `gen-lockfiles` in the error.
The `unverified = true` option permits an unlocked download with a warning.

## Use Zola in a task

`zola.graph_toolchain(version)` returns `{ tool, version }`. Omit `version`
to select the declared default. Declare the tool before task execution.
`zola.zola_bin(exec, tool)` returns its absolute executable path inside a task
that declares the tool as an input.

**Illustrative example** — this task checks the installed version:

```lua
local core = require("@imp/core")
local zola = require("@imp/rules/zola")

local check = core.task({
    inputs = { zola = zola.graph_toolchain().tool },
    outputs = { version = core.output.value() },
    run = function(exec, inputs)
        local result = exec.action({
            argv = { zola.zola_bin(exec, inputs.zola), "--version" },
        })
        return { version = result.stdout }
    end,
})
```

For a site build, also declare the site sources as inputs and the generated
site as an artifact output. Imp creates declared output directories before
the action starts, so pass `--force` to Zola when it writes to that directory.
The build writes into its sandbox. Use the
`package` workflow to publish that artifact into the workspace.

Acquisition checks the locked download size and SHA-256 digest. It extracts
Zola at the archive root into the shared `zola-toolchains` named cache, keyed
by version and platform. Linux and macOS use tar.gz archives; Windows uses
ZIP archives and `zola.exe`. The platform map includes Linux and macOS
x86_64/aarch64 and Windows x86_64. Acquisition requires the native tools used
by the shared download and archive rules, including `sh`, `curl`, and the
applicable hash and extraction tools.

Luau uses graph-tool inputs. It does not provide local cache installation,
legacy tool descriptors, or `imp @tool` dispatch.

## JavaScript compatibility

The existing JavaScript documentation build remains available during the
migration. It uses this declaration:

```js
import { zolaToolchain } from "//rules/zola";

export const zola = zolaToolchain("0.22.1", { default: true });
```

JavaScript rules use `zolaGraphTool()` for a graph input. The generated API
references still describe JavaScript. Luau reference extraction belongs to
`2026-09-30-integrate-luau-workspace-tests-and-docs`.

## Validate the package

From the Imp source checkout, build the current binary and run:

```sh
cargo build -p imp
IMP_RUNTIME=luau IMP_RULES_DIR="$PWD/rules" target/debug/imp test //rules/zola:rules_test
python3 rules/zola/testdata/consumer_check.py --imp target/debug/imp
```

The focused tests check platform mappings and acquisition with fake actions.
The consumer check acquires the real default release, builds and packages a
minimal site, checks source edits, and checks failure propagation. It needs
network access on a cache miss. Native execution on other platforms requires
separate validation.
