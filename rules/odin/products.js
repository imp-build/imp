// Product-name tokens for roles the Odin rules consume from other rule
// groups. A leaf module (no imports from the rule tree) so providers like
// //rules/c/mold can register the role and //rules/odin can look it up
// without importing each other's full modules.
import { productName } from "imp:core";

/** Role: resolve a linker toolchain target to the linker configuration Odin
 * builds pass to `odin build` (see odinLinkFlags in //rules/odin). */
export const ODIN_LINKER = productName("odin-linker");
