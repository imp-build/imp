// Generic `generate` goal, wiring //rules/imp/generate's `generatedFiles()`
// helper into the build graph: `generate` writes a target's generated files
// into the workspace, `generate --check` verifies they're already up to date
// without writing — for CI drift gates on committed codegen (see
// //rules/imp/generate.js's doc comment for the product-authoring pattern).
// `check` is passed straight through to each product function as a second
// argument (`fn(handle, {check})`) rather than registering a second product —
// same convention fmtGoal uses (//rules/workflows/fmt_goal.js).
//
// This module only provides the shared dispatch goal; a rule package adds a
// `generate` product for its own target kind following the pattern
// documented in generate.js (e.g. //ci:docs_workflow).
import { goal, resolveProducts, goalFlags, logInfo } from "imp:core";

export async function generateGoal(selection) {
	const { check } = goalFlags();
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle, { check }),
	}));

	const summaryLines = [];
	const staleReports = [];
	for (const { label, promise } of calls) {
		let result;
		try {
			result = await promise;
		} catch (e) {
			throw new Error(`${label}: ${e && e.message ? e.message : e}`);
		}
		if (check) {
			const stale = (result && result.stale) || [];
			if (stale.length > 0) {
				summaryLines.push(`- ${label}: ${stale.length} file(s) out of date`);
				for (const file of stale) staleReports.push(`${label}: ${file}`);
			}
		} else {
			const count = (result && result.generated) || 0;
			if (count > 0) {
				summaryLines.push(`- ${label}: ${count} file(s) generated`);
			}
		}
	}

	if (summaryLines.length > 0) {
		logInfo(["generate:", ...summaryLines].join("\n"));
	}
	if (check && staleReports.length > 0) {
		throw new Error(
			`generated files out of date:\n${staleReports.map((f) => `  ${f}`).join("\n")}`,
		);
	}
}

export const GENERATE = goal("generate", generateGoal, {
	flags: {
		check: {
			description:
				"Verify generated files are up to date without writing changes",
		},
	},
});
