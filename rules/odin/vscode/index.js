// Attaches a [VSCODE] facet to every declared Odin graph package, consumed
// by //rules/workflows/vs's graph goal handler to emit VS/VS Code IDE
// config. Import this module for its side effect (registerOdinPackageHook)
// to opt a workspace into `imp vs`.

import { VSCODE } from "//rules/workflows/vs";
import { digestOf, output, pathsInDigest, task } from "imp:core";
import { registerOdinPackageHook } from "//rules/odin";

function odinVscodeRoot(value, analysis) {
	return task({
		display: `vscode metadata ${value.base}`,
		inputs: { sources: value.sources, analysis },
		outputs: { info: output.value() },
		async run(_exec, input) {
			const digest = digestOf(input.sources.fileset);
			const sourcePaths = new Set(pathsInDigest(digest));
			const files = input.analysis.files || {};
			const info = { packagePath: value.base, hasMainEntrypoint: false };
			for (const path of sourcePaths) {
				const file = files[path];
				if (file) info.hasMainEntrypoint ||= file.hasMainEntrypoint;
			}
			return { info };
		},
	});
}

registerOdinPackageHook((value, analysisHandleThunk) => {
	return {
		[VSCODE]: odinVscodeRoot(value, analysisHandleThunk()).outputs.info,
	};
});
