import { describe, expect, test } from "//rules/imp/test";
import { output, task } from "imp:core";

// A shared helper that builds several different actions from one task() call
// site, telling them apart with a closure-captured flag — the shape every
// ruleset uses (odin's build/test/lint, cmake's configure variants). The run
// callback is anonymous and the call site is one line, so the task's function
// identity is the same for every variant; `display` is what separates them.
function variantTask(displayText, { outputs = undefined } = {}) {
	return task({
		display: displayText,
		inputs: { shared: "constant" },
		outputs,
		run() {
			return undefined;
		},
	});
}

describe("graph node identity", () => {
	// Issue: odin's [TEST] silently resolved to the [BUILD] task, because the
	// two differed only in a closure-captured flag that the task key never saw.
	// `imp test` ran `odin build` and reported success without running a test.
	test("tasks differing only in display are distinct nodes", () => {
		const build = variantTask("odin build pkg");
		const testing = variantTask("odin test pkg");
		expect(build.__graph_id).not.toBe(testing.__graph_id);
	});

	test("tasks with an identical display still dedupe", () => {
		const first = variantTask("odin build pkg");
		const second = variantTask("odin build pkg");
		expect(first.__graph_id).toBe(second.__graph_id);
	});

	// The `task ${id}` display fallback is unique per node, so it must stay out
	// of the key — otherwise every unnamed task becomes its own node and dedupe
	// stops working entirely.
	test("tasks with no authored display dedupe on their inputs", () => {
		const first = variantTask(undefined);
		const second = variantTask(undefined);
		expect(first.__graph_id).toBe(second.__graph_id);
	});

	test("display does not override a real difference in outputs", () => {
		const bare = variantTask("same display", { outputs: {} });
		const valued = variantTask("same display", {
			outputs: { result: output.value() },
		});
		expect(bare.__graph_id).not.toBe(valued.__graph_id);
	});
});
