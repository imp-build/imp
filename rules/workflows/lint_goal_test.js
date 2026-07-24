import { describe, expect, test } from "//rules/imp/test";
import { lintGoal } from "//rules/workflows/lint_goal";
import { product, target, LINT, targetKind, toolName } from "imp:core";

const TEST_TOOL = toolName("lint-test-tool");
const K_lint_goal_test_clean = targetKind("lint-goal-test-clean");
const K_lint_goal_test_dirty = targetKind("lint-goal-test-dirty");
const K_lint_goal_test_fixable = targetKind("lint-goal-test-fixable");
const K_lint_goal_test_unfixable = targetKind("lint-goal-test-unfixable");

async function withFakeGoalFlags(flags, fn) {
	const real = globalThis.__host_current_goal_flags;
	globalThis.__host_current_goal_flags = () => JSON.stringify(flags);
	try {
		return await fn();
	} finally {
		globalThis.__host_current_goal_flags = real;
	}
}

async function withFakeLog(fn) {
	const real = globalThis.__host_log;
	const logs = [];
	globalThis.__host_log = (level, message) => {
		logs.push({ level, message });
	};
	try {
		await fn(logs);
	} finally {
		if (real === undefined) delete globalThis.__host_log;
		else globalThis.__host_log = real;
	}
}

describe("lint workflow", () => {
	test("lintGoal passes {fix} through to every product function", async () => {
		const seen = [];
		product(
			K_lint_goal_test_clean,
			LINT,
			TEST_TOOL,
			async (handle, opts) => {
				seen.push(opts);
				return {
					ok: true,
					output: "",
					fixSupported: true,
					fixApplied: false,
					outputDigest: null,
				};
			},
			{ display: "lint {0}", level: "info" },
		);
		const clean = target({ kind: "lint-goal-test-clean" });

		await withFakeGoalFlags({ fix: true }, async () => {
			await lintGoal([
				{
					id: clean.__id,
					address: "//:clean",
					kind: "lint-goal-test-clean",
					product: "lint",
				},
			]);
		});

		expect(seen.length).toBe(1);
		expect(seen[0].fix).toBe(true);
	});

	test("lintGoal runs and reports every target before throwing", async () => {
		product(
			K_lint_goal_test_dirty,
			LINT,
			TEST_TOOL,
			async () => ({
				ok: false,
				output: "boom",
				fixSupported: false,
				fixApplied: false,
				outputDigest: null,
			}),
			{ display: "lint {0}", level: "info" },
		);
		const a = target({ kind: "lint-goal-test-dirty" });
		const b = target({ kind: "lint-goal-test-dirty" });

		await withFakeGoalFlags({ fix: false }, async () => {
			let message = "";
			await withFakeLog(async (logs) => {
				try {
					await lintGoal([
						{
							id: a.__id,
							address: "//:a",
							kind: "lint-goal-test-dirty",
							product: "lint",
						},
						{
							id: b.__id,
							address: "//:b",
							kind: "lint-goal-test-dirty",
							product: "lint",
						},
					]);
				} catch (error) {
					message = error.message;
				}
				// Both failed targets are named, not just the first one hit — the
				// loop finishes every target before deciding to throw.
				expect(message).toContain("//:a#lint");
				expect(message).toContain("//:b#lint");
				expect(logs.some((l) => l.message.includes("//:a#lint"))).toBe(true);
				expect(logs.some((l) => l.message.includes("//:b#lint"))).toBe(true);
			});
		});
	});

	test("lintGoal --fix logs which targets had fixes applied, but still fails on remaining errors", async () => {
		product(
			K_lint_goal_test_fixable,
			LINT,
			TEST_TOOL,
			async () => ({
				ok: false,
				output: "still one unfixable warning",
				fixSupported: true,
				fixApplied: true,
				outputDigest: "fake-digest",
			}),
			{ display: "lint {0}", level: "info" },
		);
		product(
			K_lint_goal_test_unfixable,
			LINT,
			TEST_TOOL,
			async () => ({
				ok: false,
				output: "no fix mode for this tool",
				fixSupported: false,
				fixApplied: false,
				outputDigest: null,
			}),
			{ display: "lint {0}", level: "info" },
		);
		const fixed = target({ kind: "lint-goal-test-fixable" });
		const unsupported = target({ kind: "lint-goal-test-unfixable" });

		await withFakeGoalFlags({ fix: true }, async () => {
			let message = "";
			await withFakeLog(async (logs) => {
				try {
					await lintGoal([
						{
							id: fixed.__id,
							address: "//:fixed",
							kind: "lint-goal-test-fixable",
							product: "lint",
						},
						{
							id: unsupported.__id,
							address: "//:unsupported",
							kind: "lint-goal-test-unfixable",
							product: "lint",
						},
					]);
				} catch (error) {
					message = error.message;
				}
				// ok:false still fails the goal even though a fix was applied.
				expect(message).toContain("//:fixed#lint");
				expect(message).toContain("//:unsupported#lint");
				expect(
					logs.some(
						(l) =>
							l.message.startsWith("lint --fix:") &&
							l.message.includes("//:fixed#lint") &&
							!l.message.includes("//:unsupported#lint"),
					),
				).toBe(true);
			});
		});
	});

	test("lintGoal does not throw when every target is clean", async () => {
		product(
			K_lint_goal_test_clean,
			LINT,
			TEST_TOOL,
			async () => ({
				ok: true,
				output: "",
				fixSupported: true,
				fixApplied: false,
				outputDigest: null,
			}),
			{ display: "lint {0}", level: "info" },
		);
		const clean = target({ kind: "lint-goal-test-clean" });

		await withFakeGoalFlags({ fix: false }, async () => {
			await lintGoal([
				{
					id: clean.__id,
					address: "//:clean",
					kind: "lint-goal-test-clean",
					product: "lint",
				},
			]);
		});
	});
});
