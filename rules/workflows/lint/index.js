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
import { goal, goalError, goalFlags, writeWorkspace } from "imp:core";
import { statusReport } from "//rules/workflows/report";

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
	// Returned (on an all-passing run) or thrown as the goalError message (on
	// any failure) rather than logged — see graphFmtGoal's identical reasoning
	// (rules/workflows/fmt/index.js).
	const report = statusReport(
		results.map((result) => ({
			key: result.address,
			status: !result.ok ? "fail" : result.fixApplied ? "fixed" : "clean",
			output: !result.ok ? result.output : undefined,
		})),
		{
			order: ["fail", "fixed", "clean"],
			colors: { fail: "red", fixed: "yellow", clean: "green" },
			summary: (counts) =>
				`lint: ${counts.clean} clean, ${counts.fixed} fixed, ${counts.fail} failed`,
		},
	);
	if (results.some((result) => !result.ok)) throw goalError(report);
	return report;
}

export const LINT = goal("lint", undefined, {
	graph: graphLintGoal,
	flags: { fix: { description: "Automatically fix what can be fixed" } },
});
