import { graphCodegenGoal } from "//rules/workflows/codegen";
import { expect, test, withFakeWriteWorkspace } from "//rules/imp/test";

test("publishes selected codegen files under dist/codegen at declared paths", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphCodegenGoal([
			{
				address: "//app:bindings",
				result: {
					paths: ["app/generated/bindings.odin", "app/generated/types.odin"],
					files: {
						"app/generated/bindings.odin": { digest: "bindings-digest" },
						"app/generated/types.odin": { digest: "types-digest" },
					},
				},
			},
		]);
		expect(calls).toEqual([
			{
				path: "dist/codegen/app/generated/bindings.odin",
				digest: "bindings-digest",
				from: "app/generated/bindings.odin",
			},
			{
				path: "dist/codegen/app/generated/types.odin",
				digest: "types-digest",
				from: "app/generated/types.odin",
			},
		]);
	});
});

test("publishes outputs from more than one selected producer", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphCodegenGoal([
			{
				address: "//app:bindings",
				result: { paths: ["app/bindings.odin"], files: { "app/bindings.odin": { digest: "a" } } },
			},
			{
				address: "//app:schema",
				result: { paths: ["app/schema.odin"], files: { "app/schema.odin": { digest: "b" } } },
			},
		]);
		expect(calls.map((call) => call.path)).toEqual([
			"dist/codegen/app/bindings.odin",
			"dist/codegen/app/schema.odin",
		]);
	});
});

test("rejects duplicate destinations before writing any output", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		let thrown = null;
		try {
			graphCodegenGoal([
				{
					address: "//app:first",
					result: { paths: ["app/shared.odin"], files: { "app/shared.odin": { digest: "a" } } },
				},
				{
					address: "//app:second",
					result: { paths: ["app/shared.odin"], files: { "app/shared.odin": { digest: "b" } } },
				},
			]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain("dist/codegen/app/shared.odin");
		expect(thrown.message).toContain("//app:first");
		expect(thrown.message).toContain("//app:second");
		expect(calls).toEqual([]);
	});
});

test("rejects case-only destination aliases before writing", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		let thrown = null;
		try {
			graphCodegenGoal([
				{
					address: "//app:lower",
					result: { paths: ["app/Readme.txt"], files: { "app/Readme.txt": { digest: "a" } } },
				},
				{
					address: "//app:upper",
					result: { paths: ["app/README.txt"], files: { "app/README.txt": { digest: "b" } } },
				},
			]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain("path conflict");
		expect(calls).toEqual([]);
	});
});

test("rejects file and directory destination conflicts before writing", async () => {
	for (const paths of [
		["app/generated", "app/generated/types.odin"],
		["app/generated/types.odin", "app/generated"],
	]) {
		await withFakeWriteWorkspace(async (calls) => {
			let thrown = null;
			try {
				graphCodegenGoal(
					paths.map((path, index) => ({
						address: `//app:producer${index}`,
						result: { paths: [path], files: { [path]: { digest: `d${index}` } } },
					})),
				);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeTruthy();
			expect(thrown.message).toContain("path conflict");
			expect(calls).toEqual([]);
		});
	}
});

test("rejects paths that escape dist/codegen before writing", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		let thrown = null;
		try {
			graphCodegenGoal([
				{
					address: "//app:bad",
					result: { paths: ["../outside.txt"], files: { "../outside.txt": { digest: "a" } } },
				},
			]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain("workspace-relative path");
		expect(calls).toEqual([]);
	});
});

test("rejects a root that is not a codegen result", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		let thrown = null;
		try {
			graphCodegenGoal([{ address: "//app:other", result: { type: "artifact" } }]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain("codegen() result");
		expect(calls).toEqual([]);
	});
});
