// Rustfmt product registrations live under their tool directory so product
// provenance can derive both the Rust group and the rustfmt implementation.
import { product, FMT, toolName } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
import { CargoPackage } from "//rules/rust";
import { cargoFmt, cargoFormatCheck } from "//rules/rust/fmt";

const RUSTFMT_TOOL = toolName("rustfmt");

export const cargoPackageFmt = product(
	CargoPackage,
	FMT,
	RUSTFMT_TOOL,
	cargoFmt,
);
export const cargoPackageFormatCheck = product(
	CargoPackage,
	FORMAT_CHECK,
	RUSTFMT_TOOL,
	cargoFormatCheck,
);
