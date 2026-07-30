// Ruff formatting is an additive extension on the reusable pythonApp label
// factory. Keeping it here makes `python/ruff` the fmt handler's automatic
// provenance; importing this module enables `fmt` without pulling in
// linting, for packages declared before or after the import.
import { fmt, logInfo } from "imp:core";
import { pythonApp } from "//rules/python";
import { ruffFmt } from "//rules/python/fmt";

export function pythonAppFmt(appLabel) {
	fmt(appLabel, async function fmtPythonApp(ctx) {
		const result = await ruffFmt(appLabel, {
			check: !!ctx.flags.check,
		});
		logInfo(
			ctx.flags.check
				? `${ctx.selector}#fmt checked ${result.checked} Python source(s)`
				: `${ctx.selector}#fmt formatted ${result.formatted} Python source(s)`,
		);
		return result;
	});
}

pythonApp.attach(pythonAppFmt);
