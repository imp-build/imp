Rustfmt is the formatting implementation for `cargo-package` targets. It runs
through `cargo fmt`, using the package's selected managed Rust toolchain and
the same manifest/workspace view as its other Cargo products.

```sh
# Rewrite selected packages in the workspace.
imp fmt //crates/service:service

# Check formatting without changing the workspace.
imp fmt --check //crates/service:service
```

The write mode formats inside a sandbox, computes the content changes, and
materializes only the package's Rust source files back into the workspace. The
check mode delegates to rustfmt's native `--check` behavior and does not write
files. For an outer Cargo workspace member, use `workspaceMember: true` on the
`cargoPackage()` declaration so `cargo fmt` can see the root manifest.

The product registration lives in `rules/rust/rustfmt`, which is why the Rust
capability table attributes `fmt` to rustfmt instead of introducing a separate
manual grouping declaration.
