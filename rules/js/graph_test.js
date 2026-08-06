import { BUILD, FMT, LINT, RUN } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { jsApp, tsApp } from "//rules/js";
import "//rules/js/biome";
import "//rules/js/biome/lint";

describe("JS/TS app graph declarations", () => {
	test("jsApp exports build, run, and Biome roots", () => {
		const app = jsApp({
			base: "rules/js/example",
			src: "app",
			entry: "src/index.js",
		});
		expect(app.root).toBe("rules/js/example/app");
		for (const workflow of [BUILD, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
	});

	test("tsApp exports build, run, and Biome roots", () => {
		const app = tsApp({
			base: "rules/js/example",
			src: "app_ts",
			entry: "index.js",
		});
		expect(app.root).toBe("rules/js/example/app_ts");
		for (const workflow of [BUILD, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
	});
});
