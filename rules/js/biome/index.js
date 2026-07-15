// Biome formatting registration. Keeping it here makes `js/biome` the
// products' automatic provenance; importing this module enables `fmt` and
// `format-check` for JsSources targets.
import { product, FMT } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
import { JsSources } from "//rules/js";
import { biomeFmt, biomeFormatCheck } from "//rules/js/biome/fmt";
import { BIOME_TOOL } from "//rules/js/biome_toolchain";

export const jsSourcesFmt = product(JsSources, FMT, BIOME_TOOL, biomeFmt);
export const jsSourcesFormatCheck = product(
	JsSources,
	FORMAT_CHECK,
	BIOME_TOOL,
	biomeFormatCheck,
);
