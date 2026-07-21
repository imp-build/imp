The Rust rules turn Cargo packages into imp targets without replacing Cargo's
package model. A target can build one or more binaries, run the package's test
suite, publish binaries under `dist/`, and participate in workspace-wide
formatting and linting. Rust, Cargo, the C link driver, linker, and optional
compiler cache are all declared tool dependencies rather than ambient host
requirements.

<!-- capabilities -->

## Set up the workspace

Register a default Rust toolchain in `imp.workspace.js`. Importing the
workflow modules enables their high-level commands and loads the formatter and
linter integrations:

```js
import { rustToolchain } from "//rules/rust";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/package";
import "//rules/workflows/test";

export const rust = rustToolchain("1.93.0", { default: true });
```

Toolchains may also select an explicit C link driver, linker, and sccache
target. Pinning them in the workspace file makes the same tool graph available
to build, test, and Clippy instead of letting those commands drift apart.

When an sccache target is set, `SCCACHE_BASEDIR` and rustc's
`--remap-path-prefix` are wired up automatically so cache hits survive
imp's per-run sandbox paths, and `SCCACHE_CACHE_SIZE` caps the on-disk
object cache at `4G` by default — override it via
`sccacheToolchain(version, { cacheSize: "8G" })`. Once sccache has been used
at least once, `imp cache stats --details` also prints its own
`--show-stats` output (hit rate, compile counts, …) alongside the on-disk
size for the `sccache-data` cache.

This repository's workspace also imports `//rules/imp/mode`, which declares
the `default` (`opt=debug`) and `release` (`opt=release`) profiles. Cargo
builds follow the selected profile:

```sh
imp build --profile release //path/to/package:server
```

`release: true` on an individual `cargoPackage()` remains an unconditional
opt-in to Cargo's release profile.

## Declare a Cargo package

In the directory containing `Cargo.toml`, add a `BUILD.js`:

```js
import { cargoPackage } from "//rules/rust";

export const server = cargoPackage({
    bin: "server",
    release: true,
});
```

The export name forms the target address, so this declaration is selected as
`//path/to/package:server`. Set `path` when the manifest is below the declaring
`BUILD.js`. `bin` accepts a string or a list and must name the binaries Cargo
produces. A library-only crate omits `bin`; it can still be formatted, linted,
and tested, but has no binary artifact for `build` or `package`.

For a package declared inside an enclosing Cargo workspace, set
`workspaceMember: true`. That stages the workspace root and sibling path
dependencies so Cargo can resolve the outer `[workspace]`. Leave it false for
a standalone crate or for the target representing the workspace root itself.

## Run goals

```sh
imp build //path/to/package:server
imp test //path/to/package:server
imp fmt --check //path/to/package:server
imp lint //path/to/package:server
imp package //path/to/package:server
```

`build` captures Cargo's selected binaries in the task result. `package`
publishes the build output to `dist/path/to/package/server`. Tests are always
executed rather than replaying a cached successful run; compilation work below
the test invocation can still use the normal task and compiler caches.

`cargoArgs` and `testArgs` append arguments to the corresponding Cargo command.
Use `testTools` for host programs that tests invoke: they become declared tool
dependencies and are placed on the sandbox's `PATH`. Use `deps` for additional
target inputs such as resources referenced by `include_str!` or
`include_bytes!`.

## Generate missing BUILD files

The Rust build generator can declare packages for otherwise unowned
`Cargo.toml` files. Enable it explicitly in `imp.workspace.js`:

```js
import "//rules/rust/generate_build";

export const rustConfig = {
    buildGenerate: true,
};
```

Then run `imp goal generate-build`. The generator uses `cargo metadata` to
identify package names, binaries, workspace roots, and workspace members. It is
off by default and does not rewrite declarations that already own a manifest.
