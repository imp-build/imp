import { digestOf, output, semantic, task } from "imp:core";
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
			// fmt formats in place — the sandbox's mounted inputs are writable,
			// not read-only, so there's no need to cp sources aside first. This
			// also keeps the declared output digest rooted exactly like
			// sourcesDigest (both real workspace-relative paths under
			// source.root), so graphFmtGoal can diffDigests() them directly.
			// lint still copies into fixed/, since --fix's output is a
			// deliberately separate artifact from the (untouched) sources.
			const command =
				kind === "fmt"
					? exec.tool(inputs.ruff, "ruff")
					: `../${exec.tool(inputs.ruff, "ruff")}`;
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					kind === "fmt"
						? 'check=$1; ruff=$2; shift 2; "$ruff" format "$@" ${check:+--check}'
						: 'fix=$1; ruff=$2; shift 2; for path in "$@"; do mkdir -p "fixed/$(dirname "$path")" && cp "$path" "fixed/$path"; done && cd fixed && "$ruff" check --color=always "$@" ${fix:+--fix}',
					`ruff-${kind}`,
					inputs.flag ? "1" : "",
					command,
					...paths,
				],
				inputs: [inputs.sources],
				tools:
					kind === "fmt"
						? [inputs.shell]
						: [inputs.shell, inputs.cp, inputs.mkdir, inputs.dirname],
				outputs:
					kind === "fmt"
						? { formatted: output.directory(source.root) }
						: { fixed: output.directory("fixed") },
				allowFailure: true,
			});
			if (kind === "fmt")
				return {
					result: {
						formatted: result.outputs.formatted,
						sourcesDigest: digestOf(inputs.sources.fileset),
						paths,
						check: { requested: inputs.flag, failed: result.exitCode !== 0 },
						output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
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
