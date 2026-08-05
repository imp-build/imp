import { BUILD } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { jsSources } from "//rules/js";

describe("jsSources graph", () => {
	test("exports an immutable source and build root", () => {
		const source = jsSources({ base: "rules/js", src: "example" });
		expect(source.sources.__imp_graph_handle).toBe(true);
		expect(source[BUILD]).toBe(source.sources);
		expect(Object.isFrozen(source)).toBe(true);
	});

	test("rejects source paths outside the workspace", () => {
		expect(() => jsSources({ base: "rules/js", src: "../outside" })).toThrow(
			"must stay within the workspace",
		);
	});
});
