// Goal-only formatting workflow. `imp fmt` reformats a target's own sources
// in place; `imp fmt --check` verifies they're already formatted without
// mutating the tree.
//
// Importing this module registers the "fmt" goal but enables no formatter on
// its own — each language's fmt integration (e.g. //rules/python/ruff/fmt,
// //rules/js/biome/fmt) is a separate opt-in import, so callers such as
// `imp init` can enable only the integrations a workspace selected.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired — every selected target now needs a real [FMT] graph handle.
// attach(label, "fmt", fn) (the `fmt()` sugar in imp:core) is a separate,
// still-supported mechanism and is unaffected.
import { goal, goalFlags, logInfo, writeWorkspace } from "imp:core";

/** Materialize CAS-only formatter results at the workflow boundary. */
export function graphFmtGoal(roots) {
	const { check } = goalFlags();
	const summaryLines = [];
	const unformatted = [];
	for (const { address, result } of roots) {
		if (!result || !result.formatted || !Array.isArray(result.paths)) continue;
		if (result.check?.failed) {
			unformatted.push(`${address}: formatting check failed`);
			continue;
		}
		if (!check) {
			for (const path of result.paths) {
				writeWorkspace(path, result.formatted.digest, {
					from: `formatted/${path}`,
				});
			}
			summaryLines.push(
				`- ${address}: formatted ${result.paths.length} source(s)`,
			);
		}
	}
	if (summaryLines.length > 0) logInfo(["fmt:", ...summaryLines].join("\n"));
	if (unformatted.length > 0)
		throw new Error(
			`not formatted:\n${unformatted.map((line) => `  ${line}`).join("\n")}`,
		);
}

export const FMT = goal("fmt", undefined, {
	graph: graphFmtGoal,
	flags: {
		check: { description: "Verify formatting without writing changes" },
	},
});
