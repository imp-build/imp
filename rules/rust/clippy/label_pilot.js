// Issue #76 pilot: independently shipped lint integration for the
// conventional Rust label factory.
import { lint, logInfo } from "imp:core";
import { cargoClippyPath, cargoPackagePath } from "//rules/rust/label_pilot";

export function clippy(packageLabel) {
	lint(packageLabel, async function lintCargoPackage(ctx) {
		const result = await cargoClippyPath(
			cargoPackagePath(packageLabel, ctx),
			!!ctx.flags.fix,
		);
		if (result.output) logInfo(`${ctx.selector}#lint:\n${result.output}`);
		if (!result.ok) throw new Error(`clippy failed for ${ctx.selector}`);
		if (result.fixed > 0) {
			logInfo(
				`${ctx.selector}#lint applied fixes to ${result.fixed} source(s)`,
			);
		}
		return result;
	});
}
