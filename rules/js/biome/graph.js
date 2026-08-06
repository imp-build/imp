import { output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { biomeGraphTool } from "//rules/js/biome/toolchain";

/** Build the CAS-only task shared by Biome's fmt and lint graph roots. */
function biomeRoot({ sources, root }, kind) {
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	const flag = kind === "fmt" ? semantic.flag("check") : semantic.flag("fix");
	return task({
		display: `biome ${kind} ${root}`,
		inputs: {
			sources,
			biome: biomeGraphTool(),
			flag,
			shell,
			cp,
			mkdir,
			dirname,
		},
		outputs:
			kind === "fmt"
				? {
						formatted: output.artifact(),
						paths: output.value(),
						check: output.value(),
					}
				: { result: output.value() },
		async run(exec, inputs) {
			const paths = exec.paths(inputs.sources);
			if (paths.length === 0) {
				return kind === "fmt"
					? {
							formatted: null,
							paths,
							check: { requested: inputs.flag, failed: false },
						}
					: { result: { ok: true, output: "", fixApplied: false } };
			}
			const biome = `../${exec.tool(inputs.biome, "biome")}`;
			const outDir = kind === "fmt" ? "formatted" : "linted";
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					kind === "fmt"
						? `mode="$1"; biome="$2"; shift 2; for path in "$@"; do mkdir -p "${outDir}/$(dirname "$path")" && cp "$path" "${outDir}/$path"; done && cd ${outDir} && if [ "$mode" = write ]; then "$biome" format --write "$@"; else "$biome" format "$@"; fi`
						: `fix="$1"; biome="$2"; shift 2; for path in "$@"; do mkdir -p "${outDir}/$(dirname "$path")" && cp "$path" "${outDir}/$path"; done && cd ${outDir} && "$biome" lint --colors=force "$@" \${fix:+--write}`,
					`biome-${kind}`,
					kind === "fmt"
						? inputs.check
							? "check"
							: "write"
						: inputs.flag
							? "1"
							: "",
					biome,
					...paths,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell, inputs.cp, inputs.mkdir, inputs.dirname],
				outputs: { [outDir]: output.directory(outDir) },
				allowFailure: true,
			});
			if (kind === "fmt")
				return {
					formatted: result.outputs.formatted,
					paths,
					check: { requested: inputs.flag, failed: result.exitCode !== 0 },
				};
			return {
				result: {
					ok: result.exitCode === 0,
					output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
					fixed: inputs.flag ? result.outputs.linted : null,
					paths,
					fixApplied: inputs.flag,
				},
			};
		},
	});
}

export const biomeFmtRoot = (source) => biomeRoot(source, "fmt");
export const biomeLintRoot = (source) =>
	biomeRoot(source, "lint").outputs.result;
