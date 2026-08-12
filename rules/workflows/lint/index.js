// Goal-only lint workflow. Importing this module registers the "lint" goal
// but enables no linter on its own — each language's lint integration (e.g.
// //rules/python/ruff/lint) is a separate opt-in import, so callers such as
// `imp init` can enable only the integrations a workspace selected.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired — every selected target now needs a real [LINT] graph handle,
// following the same allowFailure/{ok, output, ...} contract Rust's
// cargoPackage() and odin-package use (see //rules/rust,
// //rules/rust/workspace_expansion, //rules/odin). attach(label, "lint", fn)
// (the `lint()` sugar in imp:core) is a separate, still-supported mechanism
// and is unaffected.
import { goal, goalError, goalFlags, logInfo, writeWorkspace } from "imp:core";

/** Report graph lint roots using the same result contract as legacy linters. */
export function graphLintGoal(roots) {
	const { fix } = goalFlags();
	const results = roots.map(({ address, result }) => ({
		address,
		...(result?.result || result),
	}));
	if (fix) {
		for (const result of results) {
			if (!result.fixed?.digest || !Array.isArray(result.paths)) continue;
			for (const path of result.paths) {
				writeWorkspace(path, result.fixed.digest, { from: `fixed/${path}` });
			}
		}
	}
	for (const { address, output } of results) {
		if (output) logInfo(`${address}:\n${output}`);
	}
	const fixed = results.filter((result) => result.fixApplied);
	if (fixed.length > 0) {
		logInfo(
			`lint --fix: ${fixed.map((result) => result.address).join(", ")} had fixes applied`,
		);
	}
	const failed = results.filter((result) => !result.ok);
	logInfo(
		`lint: ${results.length - failed.length}/${results.length} target(s) clean`,
	);
	if (failed.length > 0) {
		throw goalError(
			`lint failed: ${failed.map((result) => result.address).join(", ")}`,
		);
	}
}

export const LINT = goal("lint", undefined, {
	graph: graphLintGoal,
	flags: { fix: { description: "Automatically fix what can be fixed" } },
});
