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

import { goal, runArgs, runFromTemplate, runTemplate } from "imp:core";

// A graph-native [RUN] root resolves to one of two shapes:
//
//   { argv, env, display, tools, digest }   a full program description
//   { digest, path } / { executable, executablePath }   one built executable
//
// Both carry a digest, which is staged as an ordinary sandbox input —
// run()'s input protocol is already digest-based (_materialise_inputs in
// imp_core.js converts every fileset to { kind: "digest" } before it reaches
// the host), so there is nothing to publish first.
//
// Nothing is written into the working tree to run it. An earlier version
// staged the executable at `.imp/runs/<slug>/` via writeWorkspace() so a
// workspace-relative argv could find it, which was wrong twice over:
// writeWorkspace() is for publishing a *final* digest (see its docstring),
// not ephemeral run state, and it left build output in the repo. The reason
// it was needed at all is the `workspaceCwd: true` policy below — cwd is the
// real workspace, so a relative argv resolves against the repo rather than
// the staged tree. The fix is to reach staged content by absolute path
// through $IMP_SANDBOX_ROOT, exactly as sandboxRootEnvExports() does in
// //rules/python/source.
//
// `$1` is the staged executable's path within the digest; `shift` drops it so
// the CLI tail appended by runFromTemplate() arrives as "$@". `exec` replaces
// the shell rather than wrapping it, so exit codes and signals (a Ctrl-C on
// an interactive program) pass straight through.
const LAUNCH_STAGED = 'prog=$1; shift; exec "$IMP_SANDBOX_ROOT/$prog" "$@"';

function stagedExecutableTemplate(address, digest, executablePath) {
	return runTemplate({
		argv: ["sh", "-c", LAUNCH_STAGED, `run ${address}`, executablePath],
		inputs: [{ kind: "digest", digest }],
		display: `run ${address}`,
	});
}

function templateFor(address, result) {
	// A full program description owns its own argv, so it is used verbatim —
	// its argv already references whatever it needs (a workspace-relative
	// path under the `workspaceCwd` policy, or $IMP_SANDBOX_ROOT for staged
	// content), and its `tools` are legacy tool specs run() consumes directly.
	if (Array.isArray(result.argv)) {
		if (typeof result.digest !== "string") {
			throw new Error(
				`${address}: run graph root describing a program must supply a digest to stage`,
			);
		}
		return runTemplate({
			argv: result.argv,
			env: result.env,
			tools: result.tools,
			inputs: [{ kind: "digest", digest: result.digest }],
			display: result.display || `run ${address}`,
		});
	}
	const executable = result.executable || result;
	const executablePath = result.executablePath || executable?.path;
	if (!executable?.digest || typeof executablePath !== "string") {
		throw new Error(`${address}: run graph root must return an executable artifact`);
	}
	return stagedExecutableTemplate(address, executable.digest, executablePath);
}

export async function graphRunGoal(roots) {
	if (roots.length !== 1) {
		throw new Error(`run requires a single target, got ${roots.length}: ${roots.map((root) => root.address).join(", ")}`);
	}
	const { address, result } = roots[0];
	// A graph-native run root may already have executed its program as an
	// uncached task (for example when a runtime tool must wrap an artifact).
	if (result === undefined || (result && Object.keys(result).length === 0)) return;
	return runFromTemplate(templateFor(address, result), {
		args: runArgs(),
		sandbox: true,
		workspaceCwd: true,
		impure: true,
		stream: true,
	});
}

goal("run", undefined, { graph: graphRunGoal });
