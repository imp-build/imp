// Goal-only formatting workflow. `imp fmt` reformats a target's own sources
// in place; `imp fmt --check` verifies they're already formatted without
// mutating the tree, by passing `{check: true}` into the same product
// function rather than dispatching to a separately registered product.
//
// Importing this module registers the "fmt" goal but enables no formatter on
// its own — each language's fmt integration (e.g. //rules/python/ruff/fmt,
// //rules/js/biome/fmt) is a separate opt-in import, so callers such as
// `imp init` can enable only the integrations a workspace selected.
//
// The "fmt" goal is declared with a callback so it can drive its own
// resolve/fan-out/await loop (resolveProducts) rather than delegating to a
// shared dispatch helper — every selected target gets checked and
// summarized before any unformatted file turns into a thrown error, so a
// single formatter failing to compile shouldn't hide the report for every
// other target. No built-in ruleset registers a legacy fmt product today
// (Rust's cargoPackage(), Odin's odin-package, and every other migrated
// ruleset expose [FMT] directly instead), so this callback only matters for
// targets still using the legacy target()/product() API.
import {
	goal,
	resolveProducts,
	goalFlags,
	logInfo,
	writeWorkspace,
} from "imp:core";

// `check` is passed straight through to each product function as a second
// argument (`fn(handle, {check})`) rather than remapping to a second
// registered product — same convention as lintGoal's `--fix`
// (//rules/workflows/lint). Unlike lint, the two modes return genuinely
// different result shapes (`unformatted` vs. `formatted`), so this callback
// still needs its own summary/throw logic rather than lint's simpler loop.
export async function fmtGoal(selection) {
	const { check } = goalFlags();
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle, { check }),
	}));

	const summaryLines = [];
	const unformatted = [];
	for (const { label, promise } of calls) {
		let result;
		try {
			result = await promise;
		} catch (e) {
			throw new Error(`${label}: ${e && e.message ? e.message : e}`);
		}
		if (check) {
			const files = (result && result.unformatted) || [];
			if (files.length > 0) {
				summaryLines.push(`- ${label}: ${files.length} file(s) not formatted`);
				for (const file of files) unformatted.push(`${label}: ${file}`);
			}
		} else {
			const count = (result && result.formatted) || 0;
			if (count > 0) {
				summaryLines.push(`- ${label}: ${count} file(s) reformatted`);
			}
		}
	}

	if (summaryLines.length > 0) {
		logInfo(["fmt:", ...summaryLines].join("\n"));
	}
	if (check && unformatted.length > 0) {
		throw new Error(
			`not formatted:\n${unformatted.map((f) => `  ${f}`).join("\n")}`,
		);
	}
}

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

goal("fmt", fmtGoal, {
	graph: graphFmtGoal,
	flags: {
		check: { description: "Verify formatting without writing changes" },
	},
});
