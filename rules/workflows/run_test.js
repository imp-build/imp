import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	product,
	runTemplate,
	target,
	RUN,
	targetKind,
	toolName,
} from "imp:core";
const K_run_test_reject_kind = targetKind("run-test-reject-kind");
const K_run_test_dispatch_kind = targetKind("run-test-dispatch-kind");
import { requireSingleRunnable, runGoal } from "//rules/workflows/run";
const TEST_TOOL = toolName("run-test-tool");

describe("run workflow", () => {
	test("requireSingleRunnable accepts exactly one target", () => {
		expect(() =>
			requireSingleRunnable([{ address: "//:a", kind: "odin-package" }]),
		).not.toThrow();
	});

	test("requireSingleRunnable rejects zero or multiple targets, naming every offender", () => {
		let message = "";
		try {
			requireSingleRunnable([
				{ address: "//:a", kind: "odin-package" },
				{ address: "//:b", kind: "odin-package" },
			]);
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("run requires a single target");
		expect(message).toContain("//:a");
		expect(message).toContain("//:b");
		expect(() => requireSingleRunnable([])).toThrow();
	});

	test("runGoal rejects a multi-target odin-package selection before dispatching anything", async () => {
		let ran = false;
		product(K_run_test_reject_kind, RUN, TEST_TOOL, async () => {
			ran = true;
		});

		let message = "";
		try {
			await runGoal([
				{ address: "//:a", kind: "odin-package" },
				{ address: "//:b", kind: "odin-package" },
			]);
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("run requires a single target");
		expect(ran).toBe(false);
	});

	test("runGoal dispatches the sole selected target's registered product", async () => {
		await withFakeToolchainHost(async (host) => {
			let ranWith = null;
			product(K_run_test_dispatch_kind, RUN, TEST_TOOL, async (handle) => {
				ranWith = handle;
				return runTemplate({ argv: ["program", "template-arg"] });
			});
			const fake = target({ kind: "run-test-dispatch-kind" });

			await runGoal([
				{
					id: fake.__id,
					address: "//:fake",
					kind: "run-test-dispatch-kind",
					product: "run",
				},
			]);

			expect(ranWith).toBe(fake);
			const action = host.runs[host.runs.length - 1];
			expect(action.argv).toEqual(["program", "template-arg"]);
			expect(action.sandbox).toBe(true);
			expect(action.workspaceCwd).toBe(true);
			expect(action.impure).toBe(true);
		});
	});
});
