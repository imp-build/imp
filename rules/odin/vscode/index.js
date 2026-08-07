// Attaches a [VSCODE] facet to every declared Odin graph package, consumed
// by //rules/workflows/vs's graph goal handler to emit VS/VS Code IDE
// config. Import this module for its side effect (registerOdinPackageHook)
// to opt a workspace into `imp vs`.

import { VSCODE } from "//rules/workflows/vs";
import { output, task } from "imp:core";
import { registerOdinPackageHook } from "//rules/odin";

// analysisThunk() reads real source files (glob/read_file), which is only
// valid during graph construction, not inside a sandboxed task's run() — so
// it's called synchronously here, at package-declaration time, not deferred.
// The task below just returns the already-computed literal; it makes no
// run()/exec.action() call of its own, preserving //rules/workflows/vs's
// "no build is ever triggered by this goal" guarantee.
//
// `sources` is declared as an input purely so each package gets a distinct
// task cache key (task identity is keyed by call site + inputs, and this
// function is always called from the same call site) — its content is never
// read inside run(), the result is already baked in via `info`.
function odinVscodeRoot(value, info) {
	return task({
		display: `vscode metadata ${value.base}`,
		inputs: { sources: value.sources },
		outputs: { info: output.value() },
		async run() {
			return { info };
		},
	});
}

registerOdinPackageHook((value, analysisThunk) => {
	const analysis = analysisThunk();
	const info = {
		hasMainEntrypoint: analysis.hasMainEntrypoint,
		packagePath: analysis.packagePath,
	};
	return { [VSCODE]: odinVscodeRoot(value, info).outputs.info };
});
