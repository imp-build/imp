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
import { diffDigests, goal, goalError, goalFlags, writeWorkspace } from "imp:core";
import { statusReport } from "//rules/workflows/report";

// "changed"/"failed" (from content, not just exit code) is a real digest
// comparison: every per-language fmt task formats its matched sources in
// place (the sandbox's mounted inputs are writable, not read-only) and
// declares its output at the same root the sources fileset itself uses (see
// e.g. rules/python/ruff_graph.js) — so the formatted digest and
// sourcesDigest share the same tree shape (real workspace-relative paths)
// and diffDigests() compares them directly, no extra narrowing needed.
//
// check.failed (set by the formatter task itself) is checked first — ruff
// and biome natively refuse to write under --check and report a failed exit
// code instead, so for them a content diff never even applies. But not every
// formatter has a real check mode: odinfmt always writes, so a --check run's
// pass/fail there is derived from the same diff this function already
// computes for "changed" — non-empty diff means "changed" in a write run,
// but "failed" (would need reformatting) under a --check run, since nothing
// gets published back to the workspace either way.
function unitStatus(result) {
	if (result.check?.failed) return "failed";
	if (!result.formatted || !result.sourcesDigest) return "unchanged";
	const changed =
		diffDigests(result.sourcesDigest, result.formatted.digest).length > 0;
	if (!changed) return "unchanged";
	return result.check?.requested ? "failed" : "changed";
}

/** Materialize CAS-only formatter results at the workflow boundary and report once. */
export function graphFmtGoal(roots) {
	const { check } = goalFlags();
	const units = roots
		.filter(({ result }) => result && Array.isArray(result.paths))
		.map(({ address, result }) => ({
			address,
			status: unitStatus(result),
			result,
		}));
	if (!check) {
		for (const { status, result } of units) {
			if (status === "failed" || !result.formatted) continue;
			for (const path of result.paths) {
				writeWorkspace(path, result.formatted.digest, { from: path });
			}
		}
	}
	// Returned (on an all-passing run) or thrown as the goalError message (on
	// any failure) rather than logged — see graphTestGoal's identical
	// reasoning (rules/workflows/test/index.js).
	const report = statusReport(
		units.map((unit) => ({
			key: unit.address,
			status: unit.status,
			output: unit.status === "failed" ? unit.result.output : undefined,
		})),
		{
			order: ["failed", "changed", "unchanged"],
			colors: { failed: "red", changed: "yellow", unchanged: "green" },
			summary: (counts) =>
				`fmt: ${counts.unchanged} unchanged, ${counts.changed} changed, ${counts.failed} failed`,
		},
	);
	if (units.some((unit) => unit.status === "failed")) throw goalError(report);
	return report;
}

export const FMT = goal("fmt", undefined, {
	graph: graphFmtGoal,
	flags: {
		check: { description: "Verify formatting without writing changes" },
	},
});
