import { codegen } from "//rules/imp/codegen";
import { nativeTool } from "//rules/imp/native-tool";
import { odinPackage } from "//rules/odin";
import { files } from "imp:core";

// Issue #96: a generated .odin file (e.g. Waystation's template compiler
// output) feeding into an odinPackage() build, not just hand-written
// workspace sources.
const generatedRelativePath = "value.odin";
const generatedPath = `rules/odin/example/generated/${generatedRelativePath}`;

const generatedValue = codegen({
	display: "generate the example Odin source",
	tools: { sh: nativeTool("sh") },
	inputs: {
		source: files({
			root: "rules/odin/example/generated",
			include: ["BUILD.js"],
		}),
	},
	outputPaths: [generatedPath],
	argv: (exec, { sh }) => [
		exec.tool(sh, "sh"),
		"-c",
		'printf "package generated\\n\\nGeneratedValue :: 42\\n" > "$1"',
		"gen",
		generatedPath,
	],
});

export const app = odinPackage({
	srcs: ["*.odin"],
	generatedSrcs: [generatedValue],
	toolchain: "dev-2026-03",
});
