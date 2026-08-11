// The "run" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Run products return a template describing their executable. This workflow
// owns the common policy: every program is impure, runs in a sandbox, starts
// in the real workspace, and receives the CLI tail after `--`.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired — every selected target now needs a real [RUN] graph handle.
// attach(label, "run", fn) (the `runGoal()` sugar in imp:core) is a separate,
// still-supported mechanism and is unaffected.

import { goal, runArgs, runFromTemplate, runTemplate, writeWorkspace } from "imp:core";

export async function graphRunGoal(roots) {
	if (roots.length !== 1) {
		throw new Error(`run requires a single target, got ${roots.length}: ${roots.map((root) => root.address).join(", ")}`);
	}
	const { address, result } = roots[0];
	// A graph-native run root may already have executed its program as an
	// uncached task (for example when a runtime tool must wrap an artifact).
	if (result === undefined || (result && Object.keys(result).length === 0)) return;
	const executable = result?.executable || result;
	const executablePath = result?.executablePath || executable?.path;
	if (!executable?.digest || typeof executablePath !== "string") {
		throw new Error(`${address}: run graph root must return an executable artifact`);
	}
	const slug = address.replace(/^\/\//, "").replace(/[:/]/g, "_") || "root";
	const root = `.imp/runs/${slug}`;
	const executableFile = `${root}/${executablePath}`;
	writeWorkspace(executableFile, executable.digest, { from: executablePath });
	return runFromTemplate(
		runTemplate({ argv: [executableFile], display: `run ${address}` }),
		{ args: runArgs(), sandbox: true, workspaceCwd: true, impure: true, stream: true },
	);
}

goal("run", undefined, { graph: graphRunGoal });
