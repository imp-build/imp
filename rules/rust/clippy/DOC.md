Clippy lints targets declared with `cargoPackage()`:

```sh
imp lint //crates/service:service
```

It runs the equivalent of:

```sh
cargo clippy --no-deps --color=always -- -D warnings
```

Warnings therefore fail the lint goal. `--no-deps` keeps each result scoped to
the selected package: dependencies are compiled, but their Clippy diagnostics
belong to their own targets. The high-level lint goal waits for all selected
targets, prints each tool's captured diagnostics, and then reports a combined
pass/fail summary.

Clippy performs a real compilation, including build scripts. It consequently
uses the package's managed Rust compiler, C link driver, linker, resource
inputs, and kache setup just like `build` and `test`; a successful Cargo build
is not evidence that an undeclared host linker will be available to lint.

```sh
imp lint --fix //crates/service:service
```

`--fix` runs `cargo clippy --fix --allow-dirty --allow-no-vcs -- -D warnings`
and materializes only the changed `.rs` files back into the workspace.
Clippy's fix mode only machine-applies suggestions it's confident about;
warnings it can't auto-fix are still reported, and `-D warnings` still
promotes them to errors, so the lint goal still fails for anything left over
after fixing.
