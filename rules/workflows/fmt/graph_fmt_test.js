import { graphFmtGoal } from "//rules/workflows/fmt";
import { digestOf, glob } from "imp:core";
import { describe, expect, test, withFakeWriteWorkspace } from "//rules/imp/test";

// goalFlags() (called unconditionally by graphFmtGoal) errors outside real
// goal execution unless __host_current_goal_flags is stubbed — mirrors
// withFakeGoalFlags (rules/imp/test/index.js) but synchronous, so it can
// wrap a plain `() => graphFmtGoal(...)` passed to expect(...).toThrow().
function withFlags(flags, fn) {
	const real = globalThis.__host_current_goal_flags;
	globalThis.__host_current_goal_flags = () => JSON.stringify(flags);
	try {
		return fn();
	} finally {
		globalThis.__host_current_goal_flags = real;
	}
}

function checkResult({ failed, output } = {}) {
	return {
		formatted: null,
		paths: [],
		check: { requested: true, failed: !!failed },
		output,
	};
}

describe("graphFmtGoal", () => {
	test("a check failure is reported as failed, with output, and throws", () => {
		withFlags({}, () => {
			expect(() =>
				graphFmtGoal([
					{
						address: "//pkg:a",
						result: checkResult({ failed: true, output: "diff detail" }),
					},
				]),
			).toThrow("diff detail");
		});
	});

	test("a passing check is reported as unchanged", () => {
		withFlags({}, () => {
			const report = graphFmtGoal([
				{ address: "//pkg:a", result: checkResult({ failed: false }) },
			]);
			expect(report).toContain("UNCHANGED");
			expect(report).not.toContain("FAILED");
		});
	});

	test("roots without a paths array (no [FMT] result) are skipped", () => {
		withFlags({}, () => {
			const report = graphFmtGoal([
				{ address: "//pkg:a", result: undefined },
				{ address: "//pkg:b", result: checkResult({ failed: false }) },
			]);
			expect(report).not.toContain("//pkg:a");
			expect(report).toContain("//pkg:b");
		});
	});

	test("aggregates failures across every selected root, not just the first", () => {
		withFlags({}, () => {
			expect(() =>
				graphFmtGoal([
					{
						address: "//pkg:a",
						result: checkResult({ failed: true, output: "a" }),
					},
					{
						address: "//pkg:b",
						result: checkResult({ failed: true, output: "b" }),
					},
				]),
			).toThrow("//pkg:a");
		});
	});

	// Each per-language fmt task formats in place and declares its output at
	// the same root the sources fileset uses (see rules/python/ruff_graph.js),
	// so sourcesDigest and formatted.digest are directly comparable — no
	// narrowing needed. Proven here with a real digest of real repo files:
	// diffing a tree against itself must report zero differences, which would
	// fail if the two digests' roots didn't actually line up (an earlier
	// version of this code copied sources into a separate "formatted/"
	// directory first, which put the two digests at different roots and made
	// diffDigests() report every target as "changed", always). The genuine
	// "detects real content changes" half of this is covered by the manual
	// `imp fmt //...` end-to-end check instead — fabricating a second, valid
	// "formatted" tree with different content but the same real root isn't
	// possible from a plain rules-test without actually running a formatter.
	test("unchanged is a real digest comparison against the sources tree, not just exit code", () => {
		const sources = digestOf(
			glob({ root: "rules/workflows/fmt", include: ["*.js"] }),
		);
		return withFakeWriteWorkspace(async () => {
			withFlags({}, () => {
				const report = graphFmtGoal([
					{
						address: "//pkg:a",
						result: {
							formatted: { digest: sources },
							sourcesDigest: sources,
							paths: ["rules/workflows/fmt/index.js"],
							check: { requested: false, failed: false },
						},
					},
				]);
				expect(report).toContain("UNCHANGED");
			});
		});
	});

	test("--check never writes, even for an unchanged result", () => {
		return withFakeWriteWorkspace(async (calls) => {
			withFlags({ check: true }, () => {
				graphFmtGoal([
					{ address: "//pkg:a", result: checkResult({ failed: false }) },
				]);
			});
			expect(calls.length).toBe(0);
		});
	});
});
