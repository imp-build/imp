# Biome formatting, linting, and toolchains

For BUILD authors, `@imp/rules/js/biome` adds formatting facets to JavaScript
source collections and applications. Import `@imp/rules/js/biome/lint` to add
lint facets. Import each extension before declaring its targets.

## Declare and use Biome

**Runnable example**

In an empty workspace, create `imp.workspace.luau`:

```lua
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
require("@imp/rules/js/biome")
require("@imp/rules/js/biome/lint")
return {}
```

Create `BUILD.luau`:

```lua
return { sources = require("@imp/rules/js").js_sources() }
```

Add a JavaScript source file. From the workspace root, run:

```sh
IMP_RUNTIME=luau imp fmt --check //:sources
IMP_RUNTIME=luau imp fmt //:sources
IMP_RUNTIME=luau imp lint //:sources
IMP_RUNTIME=luau imp lint --fix //:sources
IMP_RUNTIME=luau imp @biome --version
```

Format check and lint report problems without changing workspace files.
Format writes successful results at the goal boundary. Lint writes fixes only
with `--fix`. Actions run in sandboxes and retain outputs in the CAS until the
goal publishes them. Biome runs from the selected source root, so its
package-local configuration resolves there. Both `biome.json` and
`biome.jsonc` are explicit action inputs, including for applications whose
source patterns exclude configuration. Lint copies the configuration into its
working tree. Configuration-only edits invalidate the action cache.
An empty source collection succeeds without running Biome.
Applications retain their build and run facets when extensions add format and
lint facets. Source selection follows the JavaScript rules' shallow defaults;
application source patterns can select nested files.

## Toolchain API

The import selects Biome `2.5.4`. `biome_toolchain(version, options)` accepts
`default`, `lockfile`, and `unverified`. It returns `version`, `lockfile`, and
a `GEN_LOCKFILES` root. Register `@imp/rules/workflows/lockfiles` and export
that declaration from BUILD to generate its lockfile with `imp gen-lockfiles`.
Use an `@workspace/...` address for a workspace-owned lockfile.

Acquisition verifies the selected lock entry. Missing files or entries fail
with a regeneration hint. `unverified = true` permits an unverified download
and logs a warning. Downloaded executables use the shared `biome-toolchains`
cache, keyed by version and platform. Both x86_64 and aarch64 mappings exist
for Linux, macOS, and Windows. Real consumer execution is verified on Linux;
macOS and Windows execution remain unverified.

For rule authors, `graph_toolchain(version)` returns a frozen `{ tool, version }`
value. Declare `tool` as a task input. Within that task,
`biome_bin(exec, tool)` returns the absolute executable path. `@biome` resolves
the final workspace default.

## Install a local executable

`install_biome_toolchain(version, source, options)` accepts a declared file
artifact output or its path handle. `options.default = true` selects it as the
default. It returns a frozen `{ tool, version }` value and registers that
version for graph consumers. It performs no download and returns no lockfile
root. It does not accept arbitrary host paths.

**Illustrative example**

A producer task supplies the executable artifact. To use a workspace file,
declare it as a fileset input to a producer task and copy it to a declared
file output in a sandboxed action. Pass that output to the installer:

```lua
local biome = require("@imp/rules/js/biome")
local installed = biome.install_biome_toolchain("local-build", producer.outputs.executable, {
    default = true,
})
```

The installer copies the file and sets executable permissions on POSIX. Its
shared `biome-local-toolchains` cache key includes version, platform, and
source digest. Changed source bytes select a different cache entry, even if
the version is unchanged. Declare the local toolchain before targets that
consume it; later declarations replace the version for subsequent consumers.

## Migration limits
