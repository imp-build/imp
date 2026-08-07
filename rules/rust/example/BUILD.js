import { cargoPackage } from "//rules/rust";
import { jsSources } from "//rules/js";

// path is explicit, not packagePath()-derived: this BUILD.js lives under
// rules/, and the host's packagePath() stack search skips //rules/* frames
// (rule-module internals) — the same reason rules/odin/example/BUILD.js
// passes an explicit `base` to odinPackage().
export const hello = cargoPackage({ path: "rules/rust/example", bin: "hello" });
export const js = jsSources({ base: "rules/rust/example" });
