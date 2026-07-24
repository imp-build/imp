// Biome formatting registration. Keeping it here makes `js/biome` the
// product's automatic provenance; importing this module enables `fmt` for
// JsSources targets.
import { product, FMT } from "imp:core";
import { JsSources } from "//rules/js";
import { biomeFmt } from "//rules/js/biome/fmt";
import { BIOME_TOOL } from "//rules/js/biome_toolchain";

export const jsSourcesFmt = product(JsSources, FMT, BIOME_TOOL, biomeFmt, {
	display: "fmt {0}",
	level: "info",
});
