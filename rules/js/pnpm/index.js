// Canonical public entrypoint for the managed pnpm toolchain.
// Implementation remains in toolchain.js so internal rule imports can stay
// cycle-free while BUILD/workspace authors use //rules/js/pnpm.
export * from "//rules/js/pnpm/toolchain";
