import { cargoPackage } from "//rules/rust/label_pilot";
import { jsSources } from "//rules/js";

export const hello = cargoPackage();
export const js = jsSources({});
