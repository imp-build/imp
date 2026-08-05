import { FMT } from "imp:core";
import { registerJsSourcesHook } from "//rules/js";
import { biomeFmtRoot } from "//rules/js/biome/fmt";

export * from "//rules/js/biome/toolchain";

// Importing this module enables Biome once for every subsequently constructed
// JS source object. Unlike attach(), the object is complete and immutable.
registerJsSourcesHook((source) => ({ [FMT]: biomeFmtRoot(source) }));
