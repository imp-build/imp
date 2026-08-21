import { odinGen, odinPackage } from "//rules/odin";

// Issue #96: a generated .odin file (e.g. Waystation's template compiler
// output) feeding into an odinPackage() build, not just hand-written
// workspace sources.
const generatedRelativePath = "value.odin";

const generatedValue = odinGen({
	srcs: ["BUILD.js"],
	out: generatedRelativePath,
	cmd: [
		"sh",
		"-c",
		'printf "package generated\\n\\nGeneratedValue :: 42\\n" > "$1"',
		"gen",
	],
});

export const app = odinPackage({
	srcs: ["*.odin"],
	generatedSrcs: [
		{ artifact: generatedValue.generated, path: generatedRelativePath },
	],
	toolchain: "dev-2026-03",
});
