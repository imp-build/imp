// Clippy is an additive extension on the reusable Cargo package label
// factory. Importing this canonical entrypoint installs it replayably.
import { lint, logInfo } from "imp:core";
import {
	cargoPackage,
	cargoPackageActionHandle,
} from "//rules/rust";
import { cargoClippy } from "//rules/rust/lint";

export function clippy(packageLabel) {
	lint(packageLabel, async function lintCargoPackage(ctx) {
		const result = await cargoClippy(
			cargoPackageActionHandle(packageLabel),
			{ fix: !!ctx.flags.fix },
		);
		if (result.output) logInfo(`${ctx.selector}#lint:\n${result.output}`);
		if (!result.ok) throw new Error(`clippy failed for ${ctx.selector}`);
		return result;
	});
}

cargoPackage.attach(clippy);
