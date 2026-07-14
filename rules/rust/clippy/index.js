// Clippy product registration is colocated with the tool identity used by
// capability and documentation discovery.
import { product, LINT } from "imp:core";
import { CargoPackage } from "//rules/rust";
import { cargoClippy } from "//rules/rust/lint";

export const cargoPackageLint = product(CargoPackage, LINT, cargoClippy);
