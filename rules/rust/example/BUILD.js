import { cargoPackage } from "//rules/rust";
import { jsSources } from "//rules/js";

export const hello = cargoPackage({
	bin: "hello",
});
export const js = jsSources({});
