import { describe, expect, test } from "//rules/imp/test";
import { read_file } from "imp:core";

describe("Python documentation", () => {
	test("the workspace guide loads both Luau Ruff facets", () => {
		const setup = read_file("rules/python/DOC.md").match(
			/^## Set up a Luau workspace\s+[\s\S]*?^```lua\r?\n([\s\S]*?)^```/m,
		);
		expect(setup).toBeTruthy();

		const imports = Array.from(
			setup[1].matchAll(/^require\("([^"]+)"\)\s*$/gm),
			(match) => match[1],
		);
		for (const module of [
			"@imp/rules/python",
			"@imp/rules/python/ruff/fmt",
			"@imp/rules/python/ruff/lint",
			"@imp/rules/workflows/fmt",
			"@imp/rules/workflows/lint",
		]) {
			expect(imports).toContain(module);
		}
	});
});
