import {
	describe,
	expect,
	test,
	withFakeDiff,
	withFakeGoalFlags,
	withFakeWriteWorkspace,
} from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";
import { generatedFiles, generatedFileIsStale } from "//rules/imp/generate";
import { graphGenerateGoal } from "//rules/workflows/generate";

// These outputPaths are never actually created — withFakeGraphRun stubs
// __host_run so no command ever executes, withFakeDiff stubs
// __host_diff_digests so the reported changes are fixed by the test, and
// withFakeWriteWorkspace stubs __host_write_workspace so no real publish
// happens either. Following the pattern in //rules/c/index_test.js: resolve
// real graph handles against a faked host instead of touching disk.
const A = "rules/imp/.fake_scratch/a.txt";
const B = "rules/imp/.fake_scratch/b.txt";
const UNRELATED = "rules/imp/.fake_scratch_other/c.txt";

// Unlike withFakeRun(), this mock honors the declared graph outputs, so a
// task's own output validation sees a real artifact per declared path.
async function withFakeGraphRun(fn) {
	const real = globalThis.__host_run;
	const runs = [];
	globalThis.__host_run = async (payload) => {
		runs.push(payload);
		const names = payload.__graphOutputNames
			? JSON.parse(payload.__graphOutputNames)
			: {};
		const graphOutputs = {};
		for (const [name, path] of Object.entries(names)) {
			const digest = `digest:${path}`;
			graphOutputs[name] = {
				__imp_graph_artifact: true,
				__imp_graph_binding: true,
				type: "artifact",
				kind: "file",
				digest,
				path,
				fingerprint: `artifact:file:${digest}`,
				inputs: [{ kind: "digest", digest }],
			};
		}
		return { stdout: "", stderr: "", exitCode: 0, graphOutputs };
	};
	try {
		return await fn(runs);
	} finally {
		globalThis.__host_run = real;
	}
}

async function resolve(handle) {
	const results = await globalThis.__imp_execute_graph_handles(
		JSON.stringify([
			{ address: "//rules/imp:gen", handleId: handle.__graph_id },
		]),
		JSON.stringify({}),
	);
	return results[0].result;
}

function scratchGenerator(outputPaths) {
	return generatedFiles({
		display: "test generate",
		tools: { shell: nativeTool("sh") },
		outputPaths,
		argv: (exec, { shell }) => [exec.tool(shell, "sh"), "-c", "true"],
	});
}

describe("generatedFiles()", () => {
	test("returns a graph handle carrying the [GENERATE] contract", async () => {
		const handle = scratchGenerator([A, B]);
		expect(handle.__imp_graph_handle).toBe(true);
		await withFakeGraphRun(async () => {
			const result = await resolve(handle);
			expect(result.paths).toEqual([A, B]);
			expect(Object.keys(result.files)).toEqual([A, B]);
			expect(result.files[A].digest).toBe(`digest:${A}`);
			expect(result.files[B].digest).toBe(`digest:${B}`);
		});
	});

	test("declares one file output per outputPath and never materializes", async () => {
		await withFakeGraphRun(async (runs) => {
			await resolve(scratchGenerator([A, B]));
			const [payload] = runs;
			expect(payload.display).toBe("test generate");
			expect(payload.outputs).toEqual([
				{ kind: "file", path: A },
				{ kind: "file", path: B },
			]);
			// The generator only ever runs sandboxed, producing CAS-only
			// outputs — publishing is graphGenerateGoal's job.
			expect(payload.materialize).toBe(false);
			// Declared tools reach the action as tools, not as inputs.
			expect(payload.tools.length).toBe(1);
			expect(payload.inputs).toEqual([]);
		});
	});

	test("takes no check flag, so both goal modes share one cache entry", async () => {
		await withFakeGraphRun(async (runs) => {
			await resolve(scratchGenerator([A]));
			expect(JSON.stringify(runs[0]).includes("check")).toBe(false);
		});
	});

	test("requires a non-empty outputPaths array", () => {
		let thrown = null;
		try {
			generatedFiles({ outputPaths: [], argv: () => ["true"] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
	});

	test("requires an argv function", () => {
		let thrown = null;
		try {
			generatedFiles({ outputPaths: [A], argv: ["true"] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
	});

	test("rejects a name used by both tools and inputs", () => {
		let thrown = null;
		try {
			generatedFiles({
				tools: { shell: nativeTool("sh") },
				inputs: { shell: nativeTool("sh") },
				outputPaths: [A],
				argv: () => ["true"],
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
	});
});

describe("generatedFileIsStale()", () => {
	test("is false when the diff reports no changes", async () => {
		await withFakeDiff([], async () => {
			expect(generatedFileIsStale(A, "digest")).toBe(false);
		});
	});

	test("an exact-path diff entry marks that output as stale", async () => {
		await withFakeDiff([{ type: "modified", path: A }], async () => {
			expect(generatedFileIsStale(A, "digest")).toBe(true);
			expect(generatedFileIsStale(B, "digest")).toBe(false);
		});
	});

	test("an ancestor-directory diff entry (whole new subtree) marks outputs under it as stale", async () => {
		// diffDigests collapses a wholly-new/removed subtree into its shallowest
		// ancestor rather than each leaf under it (e.g. the destination directory
		// didn't exist at all before a first run) — this must expand back onto
		// the exact output path, and must not mark an output under an unrelated
		// directory as stale.
		await withFakeDiff(
			[{ type: "added", path: "rules/imp/.fake_scratch" }],
			async () => {
				expect(generatedFileIsStale(A, "digest")).toBe(true);
				expect(generatedFileIsStale(B, "digest")).toBe(true);
				expect(generatedFileIsStale(UNRELATED, "digest")).toBe(false);
			},
		);
	});
});

const ROOTS = [
	{
		address: "//ci:docs_workflow",
		result: {
			paths: [A, B],
			files: { [A]: { digest: "digest-a" }, [B]: { digest: "digest-b" } },
		},
	},
];

describe("graphGenerateGoal()", () => {
	test("publishes every declared path, one writeWorkspace call per file", async () => {
		await withFakeGoalFlags({}, async () => {
			await withFakeDiff([], async () => {
				await withFakeWriteWorkspace(async (calls) => {
					graphGenerateGoal(ROOTS);
					expect(calls).toEqual([
						{ path: A, digest: "digest-a", from: A },
						{ path: B, digest: "digest-b", from: B },
					]);
				});
			});
		});
	});

	test("--check never writes and passes when nothing is stale", async () => {
		await withFakeGoalFlags({ check: true }, async () => {
			await withFakeDiff([], async () => {
				await withFakeWriteWorkspace(async (calls) => {
					graphGenerateGoal(ROOTS);
					expect(calls.length).toBe(0);
				});
			});
		});
	});

	test("--check fails, naming the stale paths", async () => {
		await withFakeGoalFlags({ check: true }, async () => {
			await withFakeDiff([{ type: "modified", path: A }], async () => {
				await withFakeWriteWorkspace(async () => {
					let thrown = null;
					try {
						graphGenerateGoal(ROOTS);
					} catch (error) {
						thrown = error;
					}
					expect(thrown).toBeTruthy();
					expect(String(thrown.message).includes(A)).toBe(true);
					expect(String(thrown.message).includes(B)).toBe(false);
				});
			});
		});
	});

	test("rejects a root that is not a generatedFiles() result", async () => {
		await withFakeGoalFlags({}, async () => {
			await withFakeWriteWorkspace(async () => {
				let thrown = null;
				try {
					graphGenerateGoal([
						{ address: "//ci:docs_workflow", result: { type: "artifact" } },
					]);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeTruthy();
			});
		});
	});
});
