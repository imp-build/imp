import { graphPackageGoal } from "//rules/workflows/package";
import { expect, test, withFakeWriteWorkspace } from "//rules/imp/test";

test("graph package roots are materialized at the workflow boundary", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphPackageGoal([
			{
				address: "//images:app",
				result: { type: "artifact", digest: "digest", path: "package" },
			},
		]);
		expect(calls).toEqual([
			{ path: "dist/images/app", digest: "digest", from: "package" },
		]);
	});
});
