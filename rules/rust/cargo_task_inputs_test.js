import { describe, expect, test } from "//rules/imp/test";
import { cargoTaskInputs } from "//rules/rust/cargo_task_inputs";

describe("cargo task inputs", () => {
	test("keeps compile inputs separate from runtime and tool inputs", () => {
		const dep = { name: "dep" };
		const testDep = { name: "test-dep" };
		const testTool = { name: "test-tool" };
		const inputs = cargoTaskInputs({
			deps: [dep],
			testDeps: [testDep],
			testTools: [testTool],
		});

		expect(inputs.bindings("compile")).toEqual({ dep0: dep });
		expect(inputs.bindings("runtime")).toEqual({
			dep0: dep,
			testDep0: testDep,
		});
		expect(inputs.bindings("tools")).toEqual({ tool0: testTool });
	});

	test("resolves inputs in the same order as their task bindings", () => {
		const inputs = cargoTaskInputs({
			deps: ["dep-0", "dep-1"],
			testDeps: ["test-dep-0"],
			testTools: ["tool-0"],
		});
		const resolved = {
			dep0: "resolved-dep-0",
			dep1: "resolved-dep-1",
			testDep0: "resolved-test-dep-0",
			tool0: "resolved-tool-0",
		};

		expect(inputs.resolved(resolved, "compile")).toEqual([
			"resolved-dep-0",
			"resolved-dep-1",
		]);
		expect(inputs.resolved(resolved, "runtime")).toEqual([
			"resolved-dep-0",
			"resolved-dep-1",
			"resolved-test-dep-0",
		]);
		expect(inputs.resolved(resolved, "tools")).toEqual(["resolved-tool-0"]);
	});
});
