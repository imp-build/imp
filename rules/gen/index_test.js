import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import { stampFile } from "//rules/gen";

async function withFakeGoalContext(fn) {
	const currentGoalFlags = globalThis.__host_current_goal_flags;
	const runArgs = globalThis.__host_run_args;
	globalThis.__host_current_goal_flags = () => "{}";
	globalThis.__host_run_args = () => "[]";
	try {
		return await fn();
	} finally {
		globalThis.__host_current_goal_flags = currentGoalFlags;
		globalThis.__host_run_args = runArgs;
	}
}

describe("generated-file rules", () => {
	test("stampFile returns an extensible label with normalized data", () => {
		const stamp = stampFile({
			output: "generated/example.txt",
			text: "hello",
		});

		expect(stamp.__imp_label).toBe(true);
		expect(stamp.data).toEqual({
			output: "generated/example.txt",
			text: "hello",
		});
		expect(typeof stampFile.attach).toBe("function");
		expect(typeof stampFile.with).toBe("function");
	});

	test("stampFile writes only when its build handler is dispatched", async () => {
		await withFakeToolchainHost(async (host) => {
			const stamp = stampFile({
				output: "generated/lazy.txt",
				text: "lazy content",
			});
			expect(host.runs.length).toBe(0);

			await withFakeGoalContext(() =>
				globalThis.__imp_dispatch_label_handlers(
					stamp.__id,
					"build",
					"//pkg:stamp",
				),
			);

			expect(host.runs.length).toBe(1);
			const action = host.runs[0];
			expect(action.argv).toEqual([
				"sh",
				"-c",
				'printf \'%s\\n\' "$2" > "$1"',
				"imp-stamp",
				"generated/lazy.txt",
				"lazy content",
			]);
			expect(action.outputs).toEqual([
				{ kind: "file", path: "generated/lazy.txt" },
			]);
			expect(action.materialize).toBe(true);
			expect(action.display).toBe("write generated/lazy.txt");
		});
	});
});
