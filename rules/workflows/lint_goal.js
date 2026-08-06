// Goal-only lint workflow. //rules/workflows/lint additionally imports all
// built-in lint products for backwards compatibility.
import { goal, resolveProducts, goalFlags, logInfo } from "imp:core";

// `fix` is passed straight through to each product function as a second
// argument (`fn(handle, {fix})`) rather than registering a second product —
// same convention fmtGoal uses for `--check` (//rules/workflows/fmt_goal.js).
// Not every lint tool has a fix mode, so the decision of what (if anything)
// to do with `fix` belongs to each linter, not to a product-lookup fallback
// here.
export async function lintGoal(selection) {
	const { fix } = goalFlags();
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle, { fix }),
	}));

	const results = [];
	for (const { label, promise } of calls) {
		results.push({ label, ...(await promise) });
	}

	for (const { label, output } of results) {
		if (output) logInfo(`${label}:\n${output}`);
	}

	if (fix) {
		const fixed = results.filter((r) => r.fixApplied);
		if (fixed.length > 0) {
			logInfo(
				`lint --fix: ${fixed.map((r) => r.label).join(", ")} had fixes applied`,
			);
		}
	}

	const failed = results.filter((r) => !r.ok);
	logInfo(
		`lint: ${results.length - failed.length}/${results.length} target(s) clean`,
	);
	if (failed.length > 0) {
		throw new Error(`lint failed: ${failed.map((r) => r.label).join(", ")}`);
	}
}

/** Report graph lint roots using the same result contract as legacy linters. */
export function graphLintGoal(roots) {
	const results = roots.map(({ address, result }) => ({
		address,
		...(result?.result || result),
	}));
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
		throw new Error(
			`lint failed: ${failed.map((result) => result.address).join(", ")}`,
		);
	}
}

goal("lint", lintGoal, {
	graph: graphLintGoal,
	flags: { fix: { description: "Automatically fix what can be fixed" } },
});
