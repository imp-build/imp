import { describe, expect, test } from "//rules/imp/test";
import { configure, product, targetKind, toolName } from "imp:core";
import { GENERATE_BUILD } from "//rules/workflows/generate_build";
const K_generate_build_test_off = targetKind("generate-build-test-off");
const K_generate_build_test_false = targetKind("generate-build-test-false");
const K_generate_build_test_on = targetKind("generate-build-test-on");
import {
	generateBuildGoal,
	registerBuildGenerator,
} from "//rules/workflows/generate_build";
const TEST_TOOL = toolName("generate-build-test-tool");

describe("generate-build workflow", () => {
	async function withFakeGoalFlags(flags, fn) {
		const real = globalThis.__host_current_goal_flags;
		globalThis.__host_current_goal_flags = () => JSON.stringify(flags);
		try {
			return await fn();
		} finally {
			globalThis.__host_current_goal_flags = real;
		}
	}

	test("a registered generator is skipped when its namespace's buildGenerate config is unset", async () => {
		let called = false;
		product(
			K_generate_build_test_off,
			GENERATE_BUILD,
			TEST_TOOL,
			async () => {
				called = true;
				return {};
			},
			{ display: "generate build {0}", level: "info" },
		);
		registerBuildGenerator({
			namespace: "generate-build-test-off-ns",
			kind: "generate-build-test-off",
		});
		configure("generate-build-test-off-ns", null);

		await withFakeGoalFlags({ check: true }, async () => {
			await generateBuildGoal([]);
		});

		expect(called).toBe(false);
	});

	test("a registered generator is skipped when its namespace's buildGenerate config is false", async () => {
		let called = false;
		product(
			K_generate_build_test_false,
			GENERATE_BUILD,
			TEST_TOOL,
			async () => {
				called = true;
				return {};
			},
			{ display: "generate build {0}", level: "info" },
		);
		registerBuildGenerator({
			namespace: "generate-build-test-false-ns",
			kind: "generate-build-test-false",
		});
		configure("generate-build-test-false-ns", null);
		configure("generate-build-test-false-ns", { buildGenerate: false });

		await withFakeGoalFlags({ check: true }, async () => {
			await generateBuildGoal([]);
		});

		expect(called).toBe(false);
	});

	test("a registered generator runs when its namespace's buildGenerate config is true", async () => {
		let called = false;
		product(
			K_generate_build_test_on,
			GENERATE_BUILD,
			TEST_TOOL,
			async () => {
				called = true;
				return {};
			},
			{ display: "generate build {0}", level: "info" },
		);
		registerBuildGenerator({
			namespace: "generate-build-test-on-ns",
			kind: "generate-build-test-on",
		});
		configure("generate-build-test-on-ns", null);
		configure("generate-build-test-on-ns", { buildGenerate: true });

		await withFakeGoalFlags({ check: true }, async () => {
			await generateBuildGoal([]);
		});

		expect(called).toBe(true);
	});
});
