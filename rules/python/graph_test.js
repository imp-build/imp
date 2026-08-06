import { BUILD, FMT, LINT, PACKAGE, RUN, TEST } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { pythonApp, pythonTest } from "//rules/python";
import { pythonResolve } from "//rules/python/resolve";
import "//rules/python/ruff/fmt";
import "//rules/python/ruff/lint";

describe("Python graph declarations", () => {
	test("application exports build, package, run, and Ruff roots", () => {
		const app = pythonApp({
			base: "rules/python/example",
			entryPoint: "hello.__main__",
		});
		expect(app.root).toBe("rules/python/example");
		for (const workflow of [BUILD, PACKAGE, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
	});

	test("application accepts an explicit pythonVersion override", () => {
		const app = pythonApp({
			base: "rules/python/example",
			entryPoint: "hello.__main__",
			pythonVersion: "3.12.4",
		});
		expect(app[RUN].__imp_graph_handle).toBe(true);
	});

	test("test roots carry their resolve and test options into a graph task", () => {
		const resolve = pythonResolve({
			path: "rules/python/example",
			flavors: { default: {}, cpu: { extra: "cpu" } },
		});
		const suite = pythonTest({ resolve, testArgs: ["-q"] });
		expect(suite.root).toBe("rules/python/example");
		expect(suite[TEST].__imp_graph_handle).toBe(true);
	});
});
