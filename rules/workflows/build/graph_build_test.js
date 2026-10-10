import { graphBuildGoal } from "//rules/workflows/build";
import { expect, test, withFakeWriteWorkspace } from "//rules/imp/test";

test("writes no workspace files for any selected root", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphBuildGoal([
			{
				address: "//app:generated",
				result: { generated: { digest: "generated-digest" }, path: "app/generated.odin" },
			},
			{ address: "//app:bin", result: { digest: "bin-digest" } },
		]);
		expect(calls).toEqual([]);
	});
});
