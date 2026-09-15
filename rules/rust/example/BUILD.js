import { codegen } from "//rules/imp/codegen";
import { cargoPackage } from "//rules/rust";
import { nativeTool } from "//rules/imp/native-tool";
import { jsSources } from "//rules/js";

const generated = codegen({
	tools: { sh: nativeTool("sh") },
	outputPaths: ["rules/rust/example/src/generated.rs"],
	argv: (exec, { sh }) => [
		exec.tool(sh, "sh"),
		"-c",
		'printf \'pub const GENERATED_VALUE: &str = "generated";\\n\' > "$1"',
		"generate",
		"rules/rust/example/src/generated.rs",
	],
});

export const hello = cargoPackage({
	bin: "hello",
	generatedSrcs: [generated],
});
export const js = jsSources();
