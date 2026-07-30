// Canonical public entrypoint for the managed Node toolchain.
// Implementation remains in toolchain.js so internal rule imports can stay
// cycle-free while BUILD/workspace authors use //rules/js/node.
export * from "//rules/js/node/toolchain";
