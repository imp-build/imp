// Rustfmt is an additive extension on the reusable Cargo package label
// factory. Importing this canonical entrypoint installs it for packages
// declared before or after the import.
import { fmt, logInfo } from "imp:core";
import { cargoPackage, cargoPackageActionHandle } from "//rules/rust";
import { cargoFmt } from "//rules/rust/fmt";

export function rustfmt(packageLabel) {
	fmt(packageLabel, async function fmtCargoPackage(ctx) {
		const result = await cargoFmt(cargoPackageActionHandle(packageLabel), {
			check: !!ctx.flags.check,
		});
		logInfo(
			ctx.flags.check
				? `${ctx.selector}#fmt checked ${result.checked} Rust source(s)`
				: `${ctx.selector}#fmt formatted ${result.formatted} Rust source(s)`,
		);
		return result;
	});
}

cargoPackage.attach(rustfmt);
