import { odinPackage } from "//rules/odin";
import { jsSources } from "//rules/js";

// Fixture for #88. `app` imports "lib:greet", which itself imports "lib:util";
// neither is a declared odinPackage(), so both reach the sandbox only through
// the source closure the `lib` collection mapping implies. "core:fmt" covers
// the other side of that: an unmapped collection stays the toolchain's job.
export const app = odinPackage({
	path: "app",
	collections: { lib: "vendor" },
	toolchain: "dev-2026-03",
});

export const js = jsSources();
