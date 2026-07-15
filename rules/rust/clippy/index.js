// Clippy product registration is colocated with the tool identity used by
// capability and documentation discovery.
import { product, LINT, toolName } from "imp:core";
import { CargoPackage } from "//rules/rust";
import { cargoClippy } from "//rules/rust/lint";

const CLIPPY_TOOL = toolName("clippy");

export const cargoPackageLint = product(CargoPackage, LINT, CLIPPY_TOOL, cargoClippy);
