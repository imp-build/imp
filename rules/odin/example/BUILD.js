import { odinPackage } from "//rules/odin";
import { jsSources } from "//rules/js";

export const hello = odinPackage({
	srcs: ["*.odin"],
	toolchain: "dev-2026-03",
});
export const js = jsSources({});
