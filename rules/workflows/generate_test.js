import { describe, expect, test } from "//rules/imp/test";
import { generateGoal } from "//rules/workflows/generate";
import { product, target, targetKind, toolName } from "imp:core";
import { GENERATE_CHECK } from "//rules/workflows/products";
import { GENERATE } from "//rules/workflows/generate";
const TEST_TOOL = toolName("generate-test-tool");
const K_generate_goal_test_clean = targetKind("generate-goal-test-clean");
const K_generate_goal_test_stale_a = targetKind("generate-goal-test-stale-a");
const K_generate_goal_test_stale_b = targetKind("generate-goal-test-stale-b");
const K_generate_goal_test_all_clean = targetKind(
	"generate-goal-test-all-clean",
);
const K_generate_goal_test_write = targetKind("generate-goal-test-write");

describe("generate workflow", () => {
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

	test("generateGoal --check runs and reports every target before throwing", async () => {
		product(
			K_generate_goal_test_clean,
			GENERATE_CHECK,
			TEST_TOOL,
			async () => ({ checked: 1, stale: [] }),
		);
		product(
			K_generate_goal_test_stale_a,
			GENERATE_CHECK,
			TEST_TOOL,
			async () => ({ checked: 1, stale: ["a/gen.h"] }),
		);
		product(
			K_generate_goal_test_stale_b,
			GENERATE_CHECK,
			TEST_TOOL,
			async () => ({ checked: 2, stale: ["b/gen.h", "b/gen.rs"] }),
		);
		const clean = target({ kind: "generate-goal-test-clean" });
		const staleA = target({ kind: "generate-goal-test-stale-a" });
		const staleB = target({ kind: "generate-goal-test-stale-b" });

		await withFakeGoalFlags({ check: true }, async () => {
			let message = "";
			await withFakeLog(async (logs) => {
				try {
					await generateGoal([
						{
							id: clean.__id,
							address: "//:clean",
							kind: "generate-goal-test-clean",
							product: "generate",
						},
						{
							id: staleA.__id,
							address: "//:a",
							kind: "generate-goal-test-stale-a",
							product: "generate",
						},
						{
							id: staleB.__id,
							address: "//:b",
							kind: "generate-goal-test-stale-b",
							product: "generate",
						},
					]);
				} catch (error) {
					message = error.message;
				}
				// Both stale targets are named, not just the first one hit — the
				// loop finishes checking every target before deciding to throw.
				expect(message).toContain("//:a#generate-check");
				expect(message).toContain("a/gen.h");
				expect(message).toContain("//:b#generate-check");
				expect(message).toContain("b/gen.h");
				expect(message).toContain("b/gen.rs");
				expect(
					logs.some((l) => l.message.includes("//:a#generate-check")),
				).toBe(true);
				expect(
					logs.some((l) => l.message.includes("//:b#generate-check")),
				).toBe(true);
				expect(
					logs.some((l) => l.message.includes("//:clean#generate-check")),
				).toBe(false);
			});
		});
	});

	test("generateGoal --check does not throw when every target is already up to date", async () => {
		product(
			K_generate_goal_test_all_clean,
			GENERATE_CHECK,
			TEST_TOOL,
			async () => ({ checked: 1, stale: [] }),
		);
		const clean = target({ kind: "generate-goal-test-all-clean" });

		await withFakeGoalFlags({ check: true }, async () => {
			await generateGoal([
				{
					id: clean.__id,
					address: "//:clean",
					kind: "generate-goal-test-all-clean",
					product: "generate",
				},
			]);
		});
	});

	test("generateGoal without --check writes and reports change counts, never throws on its own", async () => {
		product(K_generate_goal_test_write, GENERATE, TEST_TOOL, async () => ({
			generated: 2,
		}));
		const pkg = target({ kind: "generate-goal-test-write" });

		await withFakeGoalFlags({ check: false }, async () => {
			await withFakeLog(async (logs) => {
				await generateGoal([
					{
						id: pkg.__id,
						address: "//:pkg",
						kind: "generate-goal-test-write",
						product: "generate",
					},
				]);
				expect(
					logs.some(
						(l) =>
							l.message.includes("//:pkg#generate") &&
							l.message.includes("2 file(s) generated"),
					),
				).toBe(true);
			});
		});
	});
});
