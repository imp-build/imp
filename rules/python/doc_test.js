import { describe, expect, test } from "//rules/imp/test";
import { read_file } from "imp:core";

describe("Python documentation", () => {
	test("the workspace guide enables fmt and lint on Python apps", async () => {
		const setup = read_file("rules/python/DOC.md").match(
			/^## Set up the workspace\s+[\s\S]*?^```js\r?\n([\s\S]*?)^```/m,
		);
		expect(setup).toBeTruthy();

		const imports = Array.from(
			setup[1].matchAll(/^import\s+"([^"]+)";\s*$/gm),
			(match) => match[1],
		);
		for (const module of imports) await import(module);

		const { pythonApp } = await import("//rules/python");
		const { FMT } = await import("//rules/workflows/fmt");
		const { LINT } = await import("//rules/workflows/lint");
		const app = pythonApp({
			base: "rules/python/example",
			entryPoint: "hello.__main__",
		});
		expect(app[FMT].__imp_graph_handle).toBe(true);
		expect(app[LINT].__imp_graph_handle).toBe(true);
	});
});
