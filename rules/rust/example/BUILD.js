import { cargoPackage } from "//rules/rust";
import { jsSources } from "//rules/js";

export const hello = cargoPackage();
export const js = jsSources({});
