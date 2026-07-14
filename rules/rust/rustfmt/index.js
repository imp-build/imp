// Rustfmt product registrations live under their tool directory so product
// provenance can derive both the Rust group and the rustfmt implementation.
import { product, FMT } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
import { CargoPackage } from "//rules/rust";
import { cargoFmt, cargoFormatCheck } from "//rules/rust/fmt";

export const cargoPackageFmt = product(CargoPackage, FMT, cargoFmt);
export const cargoPackageFormatCheck = product(CargoPackage, FORMAT_CHECK, cargoFormatCheck);
