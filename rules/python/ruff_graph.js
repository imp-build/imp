import { digestOf, files, output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	defaultRuffToolchainVersion,
	ruffGraphTool,
} from "//rules/python/ruff_toolchain";

// Ruff finds its config by a walk up from each file it checks. The sandbox
// holds only the declared inputs, so without these files the walk finds no
// config and Ruff uses its defaults. Stage the config files from the project
// root, from each parent directory up to the workspace root, and from the
// source directories below the project root. The files keep their
// workspace-relative paths, so Ruff's own discovery selects the closest
// config, as it does in an editor. A missing file matches nothing.
const RUFF_CONFIG_NAMES = ["pyproject.toml", "ruff.toml", ".ruff.toml"];

/** The Ruff config files in root and in each parent directory up to the workspace root. */
function ruffAncestorConfigFiles(root) {
	const parts = root.split("/").filter((part) => part && part !== ".");
	const include = [];
	for (let i = parts.length; i >= 0; i--) {
		// Escape glob characters, so that a directory name matches only itself.
		const dir = parts
			.slice(0, i)
			.join("/")
			.replace(/[[\]*?\\]/g, "\\$&");
		for (const name of RUFF_CONFIG_NAMES)
			include.push(dir ? `${dir}/${name}` : name);
	}
	return files({ root: ".", include });
}

/**
 * The Ruff config files below root, in the directories that the source
 * patterns can match. `src/**\/*.py` gives `src/**\/ruff.toml`, so the search
 * has the same bounds as the sources. Patterns without a directory part are
 * already covered by the files in root. Null when no pattern has a directory
 * part, because a glob must have at least one include pattern.
 */
function ruffNestedConfigFiles(root, sourcePatterns) {
	const dirs = new Set();
	for (const pattern of sourcePatterns) {
		const slash = pattern.lastIndexOf("/");
		if (slash > 0) dirs.add(pattern.slice(0, slash));
	}
	const include = [...dirs].flatMap((dir) =>
		RUFF_CONFIG_NAMES.map((name) => `${dir}/${name}`),
	);
	return include.length > 0 ? files({ root, include }) : null;
}

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
			configs: ruffAncestorConfigFiles(source.root),
			nestedConfigs: ruffNestedConfigFiles(source.root, source.sourcePatterns),
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
			// A `**/` pattern also matches root, so a path can come from both sets.
			const configPaths = [
				...new Set([
					...exec.paths(inputs.configs),
					...(inputs.nestedConfigs ? exec.paths(inputs.nestedConfigs) : []),
				]),
			];
			const command =
				kind === "fmt"
					? exec.tool(inputs.ruff, "ruff")
					: `../${exec.tool(inputs.ruff, "ruff")}`;
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					kind === "fmt"
						? 'check=$1; ruff=$2; shift 2; "$ruff" format --no-cache "$@" ${check:+--check}'
						: 'fix=$1; ruff=$2; configs=$3; shift 3; for path in "$@"; do mkdir -p "fixed/$(dirname "$path")" && cp "$path" "fixed/$path"; done && shift "$configs" && cd fixed && "$ruff" check --no-cache --color=always "$@" ${fix:+--fix}',
					`ruff-${kind}`,
					inputs.flag ? "1" : "",
					command,
					// lint copies the configs into fixed/ with the sources, then
					// drops them from the argument list so Ruff checks only sources.
					...(kind === "fmt"
						? paths
						: [String(configPaths.length), ...configPaths, ...paths]),
				],
				inputs: [inputs.sources, inputs.configs, inputs.nestedConfigs].filter(
					Boolean,
				),
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
