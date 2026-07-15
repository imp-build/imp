import {
	describe,
	expect,
	test,
	withFakeRun,
	withFakeDiff,
	withFakeWriteWorkspace,
} from "//rules/imp/test";
import { getMemoTrace } from "imp:core";
import { generatedFiles } from "//rules/imp/generate";

// These outputPaths are never actually created — withFakeRun stubs __host_run
// so no command ever executes, withFakeDiff stubs __host_diff_digests so the
// reported changes are fixed by the test, and withFakeWriteWorkspace stubs
// __host_write_workspace so no real publish happens either. Following the
// pattern in //rules/odin/odinfmt/index_test.js: exercise the declared run()
// effect and the diff-driven branch without touching disk.
const A = "rules/imp/.fake_scratch/a.txt";
const B = "rules/imp/.fake_scratch/b.txt";
const UNRELATED = "rules/imp/.fake_scratch_other/c.txt";

describe("generatedFiles()", () => {
	test("declares argv/tools/inputs/outputs on the run() effect, always materialize: false", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([], async () => {
				await withFakeWriteWorkspace(async () => {
					await generatedFiles({
						display: "test generate",
						argv: ["gen", "--flag"],
						tools: [
							{
								name: "gen",
								cache: "x",
								key: "x",
								path: "/bin/gen",
								binDirs: ["."],
							},
						],
						inputs: [],
						outputPaths: [A, B],
						materialize: true,
					});
					const { trace } = getMemoTrace();
					const runEffect = trace.find(
						(t) => t.event === "effect" && t.kind === "run",
					);
					expect(runEffect.display).toBe("test generate");
					expect(runEffect.argv).toEqual(["gen", "--flag"]);
					expect(runEffect.outputs).toEqual([
						{ kind: "file", path: A },
						{ kind: "file", path: B },
					]);
					// run() itself never materializes — publishing happens via
					// writeWorkspace() below, not run()'s own materialize:true path.
					expect(runEffect.materialize).toBe(false);
				});
			});
		});
	});

	test("materialize: true publishes every output path via writeWorkspace, one call per file", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([], async () => {
				await withFakeWriteWorkspace(async (calls) => {
					await generatedFiles({
						argv: ["gen"],
						outputPaths: [A, B],
						materialize: true,
					});
					expect(calls.length).toBe(2);
					expect(calls[0]).toEqual({
						path: A,
						digest: calls[0].digest,
						from: A,
					});
					expect(calls[1]).toEqual({
						path: B,
						digest: calls[1].digest,
						from: B,
					});
				});
			});
		});
	});

	test("materialize: false never calls writeWorkspace", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([{ type: "modified", path: A }], async () => {
				await withFakeWriteWorkspace(async (calls) => {
					await generatedFiles({
						argv: ["gen"],
						outputPaths: [A],
						materialize: false,
					});
					expect(calls.length).toBe(0);
				});
			});
		});
	});

	test("changed is empty when the diff reports no changes", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([], async () => {
				const { changed } = await generatedFiles({
					argv: ["gen"],
					outputPaths: [A, B],
					materialize: false,
				});
				expect(changed).toEqual([]);
			});
		});
	});

	test("an exact-path diff entry marks that output as changed", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([{ type: "modified", path: A }], async () => {
				const { changed } = await generatedFiles({
					argv: ["gen"],
					outputPaths: [A, B],
					materialize: false,
				});
				expect(changed).toEqual([A]);
			});
		});
	});

	test("an ancestor-directory diff entry (whole new subtree) marks every output under it as changed", async () => {
		// diffDigests collapses a wholly-new/removed subtree into its shallowest
		// ancestor rather than each leaf under it (e.g. the destination directory
		// didn't exist at all before a first run) — generatedFiles() must expand
		// that back onto the exact outputPaths it declared, and must not mark
		// outputs under an unrelated directory as changed.
		await withFakeRun(async () => {
			await withFakeDiff(
				[{ type: "added", path: "rules/imp/.fake_scratch" }],
				async () => {
					const { changed } = await generatedFiles({
						argv: ["gen"],
						outputPaths: [A, B, UNRELATED],
						materialize: false,
					});
					expect(changed).toEqual([A, B]);
				},
			);
		});
	});

	test("requires a non-empty outputPaths array", async () => {
		let thrown = null;
		try {
			await generatedFiles({
				argv: ["true"],
				outputPaths: [],
				materialize: true,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
	});

	test("requires materialize to be explicit", async () => {
		let thrown = null;
		try {
			await generatedFiles({ argv: ["true"], outputPaths: ["x"] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
	});
});
