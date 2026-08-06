import { jsApp, jsSources, tsApp } from "//rules/js";
import "//rules/js/biome/lint";

// One target per directory, not a recursive glob — src/ has its own files,
// so it gets its own target rather than being pulled in by this one.
export const hello = jsSources({ base: "rules/js/example" });
export const hello_src = jsSources({ base: "rules/js/example", src: "src" });

// Plain JS app: install-only [BUILD], [RUN] executes src/index.js directly.
export const app = jsApp({
	base: "rules/js/example",
	src: "app",
	entry: "src/index.js",
});

// TypeScript app: [BUILD] type-checks and emits via tsc, [RUN] executes the
// compiled dist/index.js.
export const app_ts = tsApp({
	base: "rules/js/example",
	src: "app_ts",
	entry: "index.js",
});
