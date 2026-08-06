// Biome linting is an additive extension on the reusable jsSources/jsApp
// graph factories. Keeping it here makes `js/biome` the lint handler's
// automatic provenance; importing this module enables lint independently of
// formatting, for sources/apps declared before or after the import.
import { LINT } from "imp:core";
import { registerJsSourcesHook } from "//rules/js";
import { registerJsAppHook } from "//rules/js/graph";
import { biomeLintRoot } from "//rules/js/biome/graph";

registerJsSourcesHook((source) => ({ [LINT]: biomeLintRoot(source) }));
registerJsAppHook((source) => ({ [LINT]: biomeLintRoot(source) }));
