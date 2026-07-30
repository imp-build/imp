// Canonical public entrypoint for the optional Rust compiler cache.
// Implementation remains in toolchain.js so internal rule imports can stay
// cycle-free while BUILD/workspace authors use //rules/rust/kache.
export * from "//rules/rust/kache/toolchain";
