// Rustfmt product registration lives under its tool directory so product
// provenance can derive both the Rust group and the rustfmt implementation.
import { product, FMT, toolName } from "imp:core";
import { CargoPackage } from "//rules/rust";
import { cargoFmt } from "//rules/rust/fmt";

const RUSTFMT_TOOL = toolName("rustfmt");

export const cargoPackageFmt = product(
	CargoPackage,
	FMT,
	RUSTFMT_TOOL,
	cargoFmt,
	{ display: "fmt {0}", level: "info" },
);
