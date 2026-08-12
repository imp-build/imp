// Generic `generate` goal, wiring //rules/imp/generate's `generatedFiles()`
// roots into the build graph: `generate` writes a target's generated files
// into the workspace, `generate --check` verifies they're already up to date
// without writing — for CI drift gates on committed codegen.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired. attach(label, "generate", fn) (the `generate()` sugar in
// imp:core) is a separate, still-supported mechanism and is unaffected.
//
// Like fmt and package, `generate` is a goal that writes: the generator runs
// sandboxed and CAS-only, and graphGenerateGoal below publishes its outputs
// at the workflow boundary. Staleness is measured here, against the real
// workspace, rather than inside the task — that keeps the generator itself
// hermetic and lets both modes share one cache entry.
import { goal, goalError, goalFlags, logInfo, writeWorkspace } from "imp:core";
import { generatedFileIsStale } from "//rules/imp/generate";

/** Publish graph generate roots at the workflow boundary, or verify them. */
export function graphGenerateGoal(roots) {
	const { check } = goalFlags();
	const stale = [];
	let checked = 0;
	for (const { address, result } of roots) {
		if (!result || !Array.isArray(result.paths) || !result.files) {
			throw goalError(
				`${address}: generate graph root must resolve to a generatedFiles() result`,
			);
		}
		for (const path of result.paths) {
			const artifact = result.files[path];
			if (!artifact || !artifact.digest) {
				throw goalError(
					`${address}: generate graph root has no artifact for '${path}'`,
				);
			}
			checked += 1;
			if (generatedFileIsStale(path, artifact.digest)) stale.push(path);
			// Publish every declared path, not only the stale ones: the diff
			// drives reporting, while writeWorkspace stays the single source
			// of truth for what lands on disk.
			if (!check) writeWorkspace(path, artifact.digest, { from: path });
		}
	}
	const listed = stale.map((path) => `  ${path}`).join("\n");
	if (check) {
		if (stale.length > 0)
			throw goalError(`generated files are out of date:\n${listed}`);
		logInfo(`generate --check: ${checked} generated file(s) up to date`);
		return;
	}
	if (stale.length > 0)
		logInfo(`generated ${stale.length} file(s):\n${listed}`);
}

export const GENERATE = goal("generate", undefined, {
	graph: graphGenerateGoal,
	flags: {
		check: {
			description:
				"Verify generated files are up to date without writing changes",
		},
	},
});
