// The "run" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Run products return a template describing their executable. This workflow
// owns the common policy: every program is impure, runs in a sandbox, starts
// in the real workspace, and receives the CLI tail after `--`.

import { goal, resolveProducts, runArgs, runFromTemplate } from "imp:core";

export function requireSingleRunnable(selection) {
	if (selection.length !== 1) {
		throw new Error(
			`run requires a single target, got ${selection.length}: ${selection.map((t) => t.address).join(", ")}`,
		);
	}
}

export async function runGoal(selection) {
	requireSingleRunnable(selection);
	const resolved = selection.flatMap(resolveProducts);
	if (resolved.length !== 1) {
		throw new Error(
			`run requires exactly one run product, got ${resolved.length}: ${resolved.map((entry) => entry.label).join(", ")}`,
		);
	}
	const { label, fn, handle } = resolved[0];
	try {
		const template = await fn(handle);
		return await runFromTemplate(template, {
			args: runArgs(),
			sandbox: true,
			workspaceCwd: true,
			impure: true,
			stream: true,
		});
	} catch (e) {
		throw new Error(`${label}: ${e && e.message ? e.message : e}`);
	}
}

goal("run", runGoal);
