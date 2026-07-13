// Clippy product registration is colocated with the tool identity used by
// capability and documentation discovery.
import { product } from "imp:core";
import { cargoClippy } from "//rules/rust/lint";

export const cargoPackageLint = product("cargo-package", "lint", cargoClippy);
