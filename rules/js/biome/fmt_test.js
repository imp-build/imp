import { FMT } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { jsSources } from "//rules/js";
import "//rules/js/biome";

describe("js fmt graph", () => {
	test("Biome import adds an immutable fmt root at source construction", () => {
		const source = jsSources({ base: "rules/js", src: "example" });
		expect(source[FMT].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(source)).toBe(true);
	});
});
