import { describe, expect, test } from "//rules/imp/test";
import { files, output, resolveGraphHandle, semantic, task } from "imp:core";

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

// resolveGraphHandle() is reachable from inside a task body: rules/rust's
// toolEnvAndTools() resolves kache's RUSTC_WRAPPER while the crate build task
// is already running. That nesting must not disturb the invocation scope the
// outer execution is standing in.
describe("nested graph resolution", () => {
	let installs = 0;

	function installTask() {
		return task({
			display: "install shared dependency",
			inputs: { shared: "install" },
			outputs: { done: output.value() },
			run() {
				installs += 1;
				return { done: installs };
			},
		}).outputs.done;
	}

	function flagReadingTask() {
		return task({
			display: "read an invocation flag",
			inputs: { check: semantic.flag("check") },
			outputs: { seen: output.value() },
			run(_exec, inputs) {
				return { seen: inputs.check };
			},
		}).outputs.seen;
	}

	async function execute(handle, invocation) {
		const results = await globalThis.__imp_execute_graph_handles(
			JSON.stringify([
				{ address: "//rules/imp:nested", handleId: handle.__graph_id },
			]),
			JSON.stringify(invocation),
		);
		return results[0].result;
	}

	// Before the fix, __imp_execute_graph_handles nulled _graphInvocation and
	// cleared the in-flight tables in its finally. A nested resolution
	// therefore tore down the scope its own caller was still standing in: the
	// semantic read after it failed with "semantic input resolved outside a
	// workflow invocation", and the shared install ran a second time because
	// its memo entry had been cleared.
	test("a task body may resolve handles without tearing down its invocation", async () => {
		installs = 0;
		const install = installTask();
		const flag = flagReadingTask();
		const outer = task({
			display: "outer task resolving handles mid-run",
			inputs: { install },
			outputs: { result: output.value() },
			async run() {
				await resolveGraphHandle(install);
				const seen = await resolveGraphHandle(flag);
				return { result: seen };
			},
		}).outputs.result;

		const result = await execute(outer, { flags: { check: true } });

		expect(result).toBe(true);
		expect(installs).toBe(1);
	});

	// At the top level there is no surrounding scope to join, so
	// resolveGraphHandle() opens its own — this is the path Toolchain.bin()
	// takes when `imp @tool` resolves a toolchain outside any goal.
	test("resolveGraphHandle opens an invocation when called outside one", async () => {
		installs = 0;
		const install = installTask();

		const first = await resolveGraphHandle(install);
		const second = await resolveGraphHandle(install);

		expect(first).toBe(1);
		// Each top-level call is its own invocation, so the in-flight table
		// does not carry over — task-level caching, not this scope, is what
		// keeps real work from repeating across invocations.
		expect(second).toBe(2);
	});

	test("resolveGraphHandle rejects a value that is not a graph handle", async () => {
		let message = "";
		try {
			await resolveGraphHandle({ nope: true });
		} catch (error) {
			message = String(error.message || error);
		}
		expect(message).toContain("expects a graph handle");
	});

	// files() builds a handle now and resolves it much later, so options
	// glob() would reject used to produce a handle that threw only if
	// something reached it — and stayed silent if nothing did. The positional
	// form is the common way in.
	test("files() rejects options with no include patterns", () => {
		let message = "";
		try {
			files({ root: "rules/imp" });
		} catch (error) {
			message = String(error.message || error);
		}
		expect(message).toContain("requires include glob patterns");
	});

	test("files() rejects a bare list of patterns", () => {
		let message = "";
		try {
			files(["rules/imp/*.js"]);
		} catch (error) {
			message = String(error.message || error);
		}
		expect(message).toContain("not a list of patterns");
	});
});
