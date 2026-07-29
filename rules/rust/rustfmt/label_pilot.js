// Issue #76 pilot: independently shipped formatting integration for the
// conventional Rust label factory.
import { fmt, logInfo } from "imp:core";
import { cargoFmtPath, cargoPackagePath } from "//rules/rust/label_pilot";

export function rustfmt(packageLabel) {
	fmt(packageLabel, async function fmtCargoPackage(ctx) {
		const result = await cargoFmtPath(cargoPackagePath(packageLabel, ctx), {
			check: !!ctx.flags.check,
		});
		if (ctx.flags.check) {
			logInfo(`${ctx.selector}#fmt checked ${result.checked} Rust source(s)`);
		} else {
			logInfo(
				`${ctx.selector}#fmt formatted ${result.formatted} Rust source(s)`,
			);
		}
		return result;
	});
}
