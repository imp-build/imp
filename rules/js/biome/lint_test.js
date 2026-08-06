import { LINT } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { jsApp, jsSources } from "//rules/js";
import "//rules/js/biome/lint";

describe("js lint graph", () => {
	test("Biome lint import adds an immutable lint root to jsSources", () => {
		const source = jsSources({ base: "rules/js", src: "example" });
		expect(source[LINT].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(source)).toBe(true);
	});

	test("Biome lint import adds an immutable lint root to jsApp", () => {
		const app = jsApp({
			base: "rules/js/example",
			src: "app",
			entry: "src/index.js",
		});
		expect(app[LINT].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
	});
});
