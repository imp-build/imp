import { describe, expect, test, withFakeRun } from "//rules/imp/test";
import { vs, vsWorkspace } from "//rules/workflows/vs";
import { odinPackageHandles } from "//rules/odin";
import { getMemoTrace } from "imp:core";

describe("vs workflow", () => {
	test("vs is exported as a function and vsWorkspace declares a vs-workspace target", () => {
		expect(typeof vs).toBe("function");
		const target = vsWorkspace();
		expect(target.kind).toBe("vs-workspace");
	});

	test("vs emits IDE config using the real output path computed by odinPackageAnalysis", {
		fixture: "workspace",
	}, async () => {
		await withFakeRun(async () => {
			// Sanity: the workspace actually has at least one odin-package
			// label for this test to be meaningful (rules/odin/example:hello).
			expect(odinPackageHandles().length > 0).toBe(true);

			const result = await vs(vsWorkspace());
			expect(result.generated.length).toBe(4);

			const { trace } = getMemoTrace();
			const tasksWrite = trace.find(
				(t) =>
					t.event === "effect" &&
					t.kind === "run" &&
					t.display === "write .vs/tasks.vs.json",
			);
			const tasks = JSON.parse(tasksWrite.argv[5]).tasks;
			const labels = tasks.map((t) => t.taskLabel);
			expect(labels).toEqual(["Build hello (Debug)", "Build hello (Release)"]);
			// rules/odin/example:hello has a main entrypoint, so its real output
			// path (via odinPackageAnalysis + odin_output_path, not guessed) has
			// no ".a" suffix. The directory component is the label's own
			// address slug (rules/odin/example:hello), not just its bare name —
			// see odinPackageOutputSlug in //rules/odin.
			expect(tasks[0].output).toBe(
				"${workspaceRoot}\\build\\odin\\rules_odin_example_hello.exe",
			);
		});
	});
});
