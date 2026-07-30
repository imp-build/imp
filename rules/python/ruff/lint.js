// Ruff linting is an additive extension on the reusable pythonApp label
// factory. Keeping it here makes `python/ruff` the lint handler's automatic
// provenance; importing this module enables `lint` without pulling in
// formatting, for packages declared before or after the import.
import { lint, logInfo } from "imp:core";
import { pythonApp } from "//rules/python";
import { ruffCheck } from "//rules/python/lint";

export function pythonAppLint(appLabel) {
	lint(appLabel, async function lintPythonApp(ctx) {
		const result = await ruffCheck(appLabel, {
			fix: !!ctx.flags.fix,
		});
		if (result.output) logInfo(`${ctx.selector}#lint:\n${result.output}`);
		if (!result.ok) throw new Error(`ruff check failed for ${ctx.selector}`);
		return result;
	});
}

pythonApp.attach(pythonAppLint);
