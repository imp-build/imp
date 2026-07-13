// Rustfmt product registrations live under their tool directory so product
// provenance can derive both the Rust group and the rustfmt implementation.
import { product } from "imp:core";
import { cargoFmt, cargoFormatCheck } from "//rules/rust/fmt";

export const cargoPackageFmt = product("cargo-package", "fmt", cargoFmt);
export const cargoPackageFormatCheck = product("cargo-package", "format-check", cargoFormatCheck);
