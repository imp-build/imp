import { output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	defaultRuffToolchainVersion,
	ruffGraphTool,
} from "//rules/python/ruff_toolchain";

function ruffRoot(source, kind) {
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	const ruff = ruffGraphTool(defaultRuffToolchainVersion());
	const flag = kind === "fmt" ? semantic.flag("check") : semantic.flag("fix");
	return task({
		display: `ruff ${kind} ${source.root}`,
		inputs: {
			sources: source.pythonSources,
			ruff,
			shell,
			cp,
			mkdir,
			dirname,
			flag,
		},
		outputs: { result: output.value() },
		async run(exec, inputs) {
			const paths = exec.paths(inputs.sources);
			if (paths.length === 0)
				return {
					result:
						kind === "lint"
							? { ok: true, output: "", fixApplied: false }
							: {
									formatted: null,
									paths,
									check: { requested: inputs.flag, failed: false },
								},
				};
			const command = `../${exec.tool(inputs.ruff, "ruff")}`;
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					kind === "fmt"
						? 'check=$1; ruff=$2; shift 2; for path in "$@"; do mkdir -p "formatted/$(dirname "$path")" && cp "$path" "formatted/$path"; done && cd formatted && "$ruff" format "$@" ${check:+--check}'
						: 'fix=$1; ruff=$2; shift 2; for path in "$@"; do mkdir -p "fixed/$(dirname "$path")" && cp "$path" "fixed/$path"; done && cd fixed && "$ruff" check --color=always "$@" ${fix:+--fix}',
					`ruff-${kind}`,
					inputs.flag ? "1" : "",
					command,
					...paths,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell, inputs.cp, inputs.mkdir, inputs.dirname],
				outputs:
					kind === "fmt"
						? { formatted: output.directory("formatted") }
						: { fixed: output.directory("fixed") },
				allowFailure: true,
			});
			if (kind === "fmt")
				return {
					result: {
						formatted: result.outputs.formatted,
						paths,
						check: { requested: inputs.flag, failed: result.exitCode !== 0 },
					},
				};
			return {
				result: {
					ok: result.exitCode === 0,
					output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
					fixed: inputs.flag ? result.outputs.fixed : null,
					paths,
					fixApplied: inputs.flag,
				},
			};
		},
	});
}

export const ruffFmtRoot = (source) => ruffRoot(source, "fmt").outputs.result;
export const ruffLintRoot = (source) => ruffRoot(source, "lint").outputs.result;
