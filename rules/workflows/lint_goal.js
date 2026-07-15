// Goal-only lint workflow. //rules/workflows/lint additionally imports all
// built-in lint products for backwards compatibility.
import { goal, resolveProducts, logInfo } from "imp:core";

export async function lintGoal(selection) {
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle),
	}));

	const results = [];
	for (const { label, promise } of calls) {
		results.push({ label, ...(await promise) });
	}

	for (const { label, output } of results) {
		if (output) logInfo(`${label}:\n${output}`);
	}

	const failed = results.filter((r) => !r.ok);
	logInfo(
		`lint: ${results.length - failed.length}/${results.length} target(s) clean`,
	);
	if (failed.length > 0) {
		throw new Error(`lint failed: ${failed.map((r) => r.label).join(", ")}`);
	}
}

goal("lint", lintGoal);
