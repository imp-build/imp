// Biome is both the JS/TS toolchain and its formatter, so this canonical
// entrypoint combines the toolchain re-export with the fmt-attach wiring.
// Importing this module enables `fmt` for jsSources labels declared before
// or after the import, with no cycle back to //rules/js.
import { fmt, logInfo } from "imp:core";
import { jsSources, jsSourcesActionHandle } from "//rules/js";
import { biomeFmt } from "//rules/js/biome/fmt";

export function jsSourcesFmt(srcLabel) {
	fmt(srcLabel, async function fmtJsSources(ctx) {
		const result = await biomeFmt(jsSourcesActionHandle(srcLabel), {
			check: !!ctx.flags.check,
		});
		logInfo(
			ctx.flags.check
				? `${ctx.selector}#fmt checked ${result.checked} JS/TS source(s)`
				: `${ctx.selector}#fmt formatted ${result.formatted} JS/TS source(s)`,
		);
		return result;
	});
}

export * from "//rules/js/biome/toolchain";

jsSources.attach(jsSourcesFmt);
