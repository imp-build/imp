// Goal-only formatting workflow. Language-specific product registrations live
// in their own rule modules so callers such as `imp init` can enable only
// the integrations a workspace selected. //rules/workflows/fmt remains the
// compatibility aggregator that enables every built-in formatter.
import { goal, resolveProducts, goalFlags, logInfo } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";

export async function fmtGoal(selection) {
	const { check } = goalFlags();
	const targets = check
		? selection.map((entry) => ({ ...entry, product: FORMAT_CHECK }))
		: selection;
	const resolved = targets.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle),
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

goal("fmt", fmtGoal, {
	flags: {
		check: { description: "Verify formatting without writing changes" },
	},
});
