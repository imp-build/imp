The Rust rules let rule authors declare Cargo packages as Imp targets. Each
target can build named binaries, run tests, format sources, report Clippy
results, and publish binaries. Cargo keeps its package model. The actions use
declared Rust, linker, compiler-cache, and test-tool dependencies.

## Set up a Luau workspace

From a workspace that contains Cargo manifests, create `imp.workspace.luau`:

```luau
require("@imp/rules/rust")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/test")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
return {}
```

Imp uses Luau for workspace and BUILD modules. JavaScript application inputs
remain supported.

The Rust toolchain module declares a pinned default. To select another pinned
version and a workspace lockfile, import the toolchain in the workspace file:

```luau
local rust = require("@imp/rules/rust/toolchain")
rust.rust_toolchain("1.98.1", {
    default = true,
    lockfile = "@workspace/locks/rust.lock",
})
```

The lockfile must contain the version and platform. Tool downloads retain
checksum verification. Export the toolchain declaration from a BUILD module
to select its `gen-lockfiles` root.

## Public API

Use `cargo_package()` to declare a Cargo package. The expansion and
registry helpers are internal rule interfaces.

### Declare a Cargo package

Add a `BUILD.luau` beside a package's `Cargo.toml`:

```luau
local rust = require("@imp/rules/rust")
return { server = rust.cargo_package({ bin = "server" }) }
```

This declares `//path/to/package:server`. `path` defaults to the BUILD module's
directory. `bin` accepts a name or a list of names. It does not infer binary
names from Cargo.toml. Omit `bin` for a library: it still has format, lint, and
test roots, but no build or package root.

Use `workspace_member = true` for a package in a Cargo workspace rooted at
".". Its directory name must equal its Cargo package name. Each workspace
shares Cargo compile, Clippy, rustfmt, and doctest actions; the rule attributes
results to each member. Standalone packages use their own actions. Cargo input
capture is recursive and excludes ignored files and `target/` directories.

The public options are:

| Option | Effect |
| --- | --- |
| `path`, `bin` | Select the manifest directory and binary outputs. |
| `release` | Build binaries with Cargo's release profile. Default: false. |
| `toolchain` | Select a Luau toolchain declaration, graph toolchain, or version. Omit to use the default. |
| `cargo_args` | Append arguments to `cargo build`. |
| `test_args` | Append arguments to the compiled test programs. |
| `deps` | Stage extra graph inputs for compilation and test execution. |
| `test_deps` | Stage extra graph inputs for test execution and doctests. |
| `test_tools` | Put declared tools on PATH for test execution and doctests. |
| `generated_srcs` | Stage generated artifacts for compilation. |
| `workspace_member` | Use the root Cargo workspace. Default: false. |
| `builtin` | Capture package sources from the installed rules tree. Default: false. |

Mode profiles and per-package doctest overrides are outside this port.

## Declare generated sources

`generated_srcs` accepts `codegen()` results or explicit
`{ artifact, path }` entries. An explicit `path` is relative to the package.
Codegen output paths are workspace-relative:

```luau
local core = require("@imp/core")
local codegen = require("@imp/rules/imp/codegen")
local rust = require("@imp/rules/rust")
local generated = codegen.codegen({
    tools = { sh = core.native_tool("sh") },
    output_paths = { "app/src/generated.rs" },
    argv = function()
        return { "sh", "-c", 'printf "pub const VALUE: u32 = 42;\\n" > "$1"',
            "generate", "app/src/generated.rs" }
    end,
})
return { app = rust.cargo_package({ path = "app", bin = "app", generated_srcs = { generated } }) }
```

The artifact must have the declared path. Different artifacts cannot claim
one path. Generated files stay in the graph. They are not written into the
workspace. Workspace compilation also stages sibling members' generated
sources.

## Run the goals

From the workspace root, after declaring the target:

```sh
imp build //path/to/package:server
imp test //path/to/package:server
imp fmt --check //path/to/package:server
imp lint //path/to/package:server
imp package //path/to/package:server
```

BUILD contains a table of binary handles keyed by each explicit `bin` name.
TEST contains `unit` and `doctests` handles. Select one with
`imp build //path/to/package:server@server` or
`imp test //path/to/package:server@doctests`. A selector without a facet runs
all facets. Selecting one binary chooses its artifact; the shared Cargo build
still compiles all declared binaries.

PACKAGE keeps one handle. It resolves to one binary artifact, or a directory
that contains all named binaries. The package goal publishes it below `dist/`.

For Luau consumers, replace an aggregate `pkg[BUILD]` task input with a named
input such as `pkg[BUILD].server`. Replace `pkg[TEST]` inputs with
`pkg[TEST].unit` and `pkg[TEST].doctests` as needed.

Test programs and doctests run without a successful-action cache; compilation
can use the normal cache. Formatting without `--check` writes the formatted
sources at the workflow boundary.

On non-Windows hosts, compilation uses the declared GCC link driver. On macOS,
where gcc has no release, the default link driver is the host `cc` from
`@imp/rules/c/host`. A Rust
toolchain declaration can set `link_driver`, `linker`, and `kache` to Luau
toolchain values. Kache uses stable absolute cache paths, a persistent worker,
and local-only storage. Its declaration accepts `cache_size` (default
`"4GiB"`). The `kache.cache_executables` workspace setting enables executable
link caching. These settings use the existing Luau toolchain APIs.

## Generate missing BUILD files

Require the generator explicitly in `imp.workspace.luau` and enable it:

```luau
require("@imp/rules/rust/generate_build")
require("@imp/rules/workflows/generate_build")
return { rust = { build_generate = true, doctest = true } }
```

Then run `imp goal generate-build`. This writes generated
`BUILD.luau` files. Use `--check` to report stale files without writing them.
The generator uses sandboxed `cargo metadata` tasks with the declared Rust
toolchain. It skips owned manifests and declared package paths, and excludes
build, vendor, hidden, and distribution directories. It emits binary names
and workspace-member flags from Cargo metadata. Imp refuses to replace a
hand-written BUILD file.

Generation is disabled by default. `rust.doctest` defaults to true and can
disable doctests for the workspace. Import the generator to register these
Rust settings even when generation stays disabled.
