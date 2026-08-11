import { describe, expect, test, withFakeRun } from "//rules/imp/test";
import { graphVsGoal } from "//rules/workflows/vs";
import { getMemoTrace } from "imp:core";

describe("vs workflow", () => {
	test("graphVsGoal is exported as a function", () => {
		expect(typeof graphVsGoal).toBe("function");
	});

	test("graphVsGoal emits IDE config from resolved [VSCODE] roots", async () => {
		await withFakeRun(async () => {
			const roots = [
				{
					address: "//rules/odin/example:hello",
					result: {
						hasMainEntrypoint: true,
						packagePath: "rules/odin/example",
					},
				},
			];

			const result = await graphVsGoal(roots);
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
			// hello has a main entrypoint, so its output path has no ".a" suffix.
			// The directory component is the address's own slug
			// (rules_odin_example_hello), not just its bare name — see
			// graphDefaultOutputPath in //rules/odin.
			expect(tasks[0].output).toBe(
				"${workspaceRoot}\\build\\odin\\rules_odin_example_hello.exe",
			);
		});
	});
});
