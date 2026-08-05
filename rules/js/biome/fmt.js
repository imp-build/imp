import { output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { biomeGraphTool } from "//rules/js/biome/toolchain";

/** Build the CAS-only result consumed by the top-level fmt graph handler. */
export function biomeFmtRoot({ sources, root }) {
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	return task({
		display: `biome format ${root}`,
		inputs: {
			sources,
			biome: biomeGraphTool(),
			check: semantic.flag("check"),
			shell,
			cp,
			mkdir,
			dirname,
		},
		outputs: {
			formatted: output.artifact(),
			paths: output.value(),
			check: output.value(),
		},
		async run(exec, inputs) {
			const paths = exec.paths(inputs.sources);
			const biome = `../${exec.tool(inputs.biome, "biome")}`;
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'mode="$1"; biome="$2"; shift 2; for path in "$@"; do mkdir -p "formatted/$(dirname "$path")" && cp "$path" "formatted/$path"; done && cd formatted && if [ "$mode" = write ]; then "$biome" format --write "$@"; else "$biome" format "$@"; fi',
					"biome-format",
					inputs.check ? "check" : "write",
					biome,
					...paths,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell, inputs.cp, inputs.mkdir, inputs.dirname],
				outputs: { formatted: output.directory("formatted") },
				allowFailure: true,
			});
			return {
				formatted: result.outputs.formatted,
				paths,
				check: { requested: inputs.check, failed: result.exitCode !== 0 },
			};
		},
	});
}
