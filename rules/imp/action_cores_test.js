import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { output, run, task } from "imp:core";

async function resolveHandles(handles) {
	const roots = handles.map((handle, index) => ({
		address: `root${index}`,
		handleId: handle.__graph_id,
	}));
	return globalThis.__imp_execute_graph_handles(
		JSON.stringify(roots),
		JSON.stringify({}),
	);
}

// A task whose body runs one action with the given options, so a test can
// read back what exec.action() forwarded to the host.
function actionTask(display, actionOpts) {
	return task({
		display,
		outputs: { out: output.artifact() },
		async run(exec) {
			const result = await exec.action({
				argv: ["sh", "-c", "true"],
				outputs: { out: output.file("out.txt") },
				...actionOpts,
			});
			return { out: result.outputs.out };
		},
	});
}

describe("exec.action({ cores })", () => {
	test("forwards the declared core count to the host", async () => {
		await withFakeToolchainHost(async (host) => {
			await resolveHandles([actionTask("wide action", { cores: 4 })]);
			const action = host.runs.find((r) => r.display === "wide action");
			expect(action.cores).toBe(4);
		});
	});

	test("defaults to one core when the action declares nothing", async () => {
		await withFakeToolchainHost(async (host) => {
			await resolveHandles([actionTask("plain action", {})]);
			const action = host.runs.find((r) => r.display === "plain action");
			expect(action.cores).toBe(undefined);
		});
	});

	// Caught at declaration rather than left to the scheduler's clamp: a
	// zero or fractional weight is a rule bug, and silently rounding it hides
	// the mistake behind an action that quietly costs the wrong amount.
	// `expect().toThrow()` is synchronous only, so catch by hand.
	test("rejects a core count that is not a whole number of one or more", async () => {
		await withFakeToolchainHost(async () => {
			for (const cores of [0, -1, 1.5]) {
				let message;
				try {
					await resolveHandles([actionTask(`bad ${cores}`, { cores })]);
				} catch (error) {
					message = String(error && error.message);
				}
				expect(message).toContain("must be an integer of 1 or more");
			}
		});
	});
});

describe("IMP_CORES", () => {
	// The other half of the contract the digest test in imp-execution's
	// exec.rs guards: the granted budget must actually reach the command, so
	// a rule can size its own job server with it instead of assuming nproc.
	//
	// These assert bounds, not an exact number, on purpose. What a command is
	// told is the *granted* budget, and the grant is clamped to the `--jobs`
	// the run was invoked with — which this suite cannot know, since it runs
	// inside a sandbox under whatever budget the outer invocation set (1 by
	// default, 8 in this workspace, 3 in CI). exec.rs's
	// `a_sandboxed_run_sees_its_core_budget_as_imp_cores` pins the exact value
	// where the budget is known.
	test("a sandboxed command sees a core count, never more than it asked for", async () => {
		const result = await run({
			argv: ["sh", "-c", 'test "$IMP_CORES" -ge 1 && test "$IMP_CORES" -le 3'],
			cores: 3,
			impure: true,
		});
		expect(result.exitCode).toBe(0);
	});

	// The clamp is what keeps the grant and the report the same number: an
	// action asking for more than the whole budget must be told what it got,
	// not what it wished for.
	test("reports the clamped grant, not an over-wide request", async () => {
		const result = await run({
			argv: ["sh", "-c", 'test "$IMP_CORES" -lt 1024'],
			cores: 1024,
			impure: true,
		});
		expect(result.exitCode).toBe(0);
	});

	// The env path has no shell to expand with, so the executor does it. A
	// rule that must pass the count through an environment variable
	// (CARGO_BUILD_JOBS, MAKEFLAGS) can then track the grant instead of
	// repeating a literal that drifts from it.
	test("expands in a declared env value, in both spellings", async () => {
		const result = await run({
			argv: [
				"sh",
				"-c",
				'test "$JOBS" = "$IMP_CORES" && test "$FLAGS" = "-j$IMP_CORES"',
			],
			env: ["JOBS=$IMP_CORES", "FLAGS=-j${IMP_CORES}"],
			cores: 2,
			impure: true,
		});
		expect(result.exitCode).toBe(0);
	});

	test("defaults to one core", async () => {
		const result = await run({
			argv: ["sh", "-c", 'test "$IMP_CORES" = 1'],
			impure: true,
		});
		expect(result.exitCode).toBe(0);
	});
});
