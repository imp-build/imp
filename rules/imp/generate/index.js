// Canonical public entrypoint for generated-file graph roots.
import {
	digestOf,
	diffDigests,
	file_set,
	output,
	task,
} from "imp:core";

/**
 * Declare a graph-native generated-files root.
 *
 * The returned handle is the `[GENERATE]` contract consumed by
 * //rules/workflows/generate's `graphGenerateGoal`: a value
 * `{paths, files}`, where `files[path]` is the action artifact holding that
 * output. The generator itself stays hermetic and cacheable — it runs
 * sandboxed, produces CAS-only outputs, and knows nothing about the `check`
 * flag, so `imp generate` and `imp generate --check` share one cache entry.
 * Everything that touches the real workspace (comparing against what is on
 * disk, and publishing) happens at the workflow boundary, the same place
 * `graphFmtGoal` and `graphPackageGoal` do their writes.
 *
 * Codegen output paths differ from input paths (generator sources/tool in,
 * e.g. `kernels_gen.h` out), and may not exist on disk yet on a first run.
 * This is unlike the in-place-formatting pattern in //rules/odin/odinfmt
 * (`odinFmtRoot`), whose output paths equal its input paths.
 *
 * `//ci:docs_workflow` (ci/BUILD.js) is the real, working example:
 *
 * ```js
 * export const docs_workflow = {
 *     [GENERATE]: generatedFiles({
 *         display: "generate GitHub workflows",
 *         tools: { python3: nativeTool("python3") },
 *         inputs: { script: file(SCRIPT) },
 *         outputPaths: [".github/workflows/docs.yml"],
 *         argv: (exec, { python3 }) => [
 *             exec.tool(python3, "python3"),
 *             SCRIPT,
 *             ".github/workflows/docs.yml",
 *         ],
 *     }),
 * };
 * ```
 *
 * @param {object} opts
 * @param {string} [opts.display] Human-readable action label.
 * @param {object} [opts.tools] Named tool handles the generator needs.
 * @param {object} [opts.inputs] Named source handles the generator reads.
 * @param {string[]} opts.outputPaths Workspace-relative paths the generator writes.
 * @param {(exec: object, inputs: object) => string[]} opts.argv Builds the
 *   generator command line from the resolved tools/inputs.
 * @returns {object} A value handle carrying `{paths, files}`.
 */
/**
 * Validate the authoring surface that `generatedFiles()` and //rules/imp/codegen's
 * `codegen()` have in common, and name one action output slot per output path.
 *
 * The two differ only in where their outputs go — the workspace, or the graph —
 * so they share one set of rules about what a caller may declare. Internal to
 * the two generator entrypoints; not part of the public rule API.
 *
 * @param {string} api Caller name, for error messages.
 * @returns {{toolNames: string[], inputNames: string[], slots: string[]}}
 */
export function planGeneratedOutputs(api, { tools, inputs, outputPaths, argv }) {
	if (!Array.isArray(outputPaths) || outputPaths.length === 0) {
		throw new Error(`${api}() requires a non-empty outputPaths array`);
	}
	if (typeof argv !== "function") {
		throw new Error(`${api}() requires an argv(exec, inputs) function`);
	}
	const toolNames = Object.keys(tools);
	const inputNames = Object.keys(inputs);
	for (const name of [...toolNames, ...inputNames]) {
		if (name === "outputPaths") {
			throw new Error(`${api}() reserves the input name 'outputPaths'`);
		}
	}
	const shared = toolNames.filter((name) => inputNames.includes(name));
	if (shared.length > 0) {
		throw new Error(
			`${api}() got the same name in tools and inputs: ${shared.join(", ")}`,
		);
	}
	const seen = new Set();
	for (const path of outputPaths) {
		if (typeof path !== "string" || path.length === 0) {
			throw new Error(`${api}() outputPaths must be non-empty strings`);
		}
		if (seen.has(path)) {
			throw new Error(`${api}() declares the output path '${path}' twice`);
		}
		seen.add(path);
	}
	// Action output slot names must match [A-Za-z0-9_.-], which output paths
	// do not, so slots are indexed and mapped back onto their path below.
	return {
		toolNames,
		inputNames,
		slots: outputPaths.map((_, index) => `out${index}`),
	};
}

export function generatedFiles({
	display,
	tools = {},
	inputs = {},
	outputPaths,
	argv,
}) {
	const { toolNames, inputNames, slots } = planGeneratedOutputs(
		"generatedFiles",
		{ tools, inputs, outputPaths, argv },
	);
	return task({
		display: display || `generate ${outputPaths.join(" ")}`,
		inputs: { ...tools, ...inputs, outputPaths },
		outputs: { result: output.value() },
		async run(exec, resolved) {
			const action = await exec.action({
				display,
				argv: argv(exec, resolved),
				tools: toolNames.map((name) => resolved[name]),
				inputs: inputNames.map((name) => resolved[name]),
				outputs: Object.fromEntries(
					slots.map((slot, index) => [
						slot,
						output.file(resolved.outputPaths[index]),
					]),
				),
			});
			return {
				result: {
					paths: resolved.outputPaths,
					files: Object.fromEntries(
						resolved.outputPaths.map((path, index) => [
							path,
							action.outputs[slots[index]],
						]),
					),
				},
			};
		},
	}).outputs.result;
}

/**
 * Report whether the generated content at `digest` differs from the file
 * currently at `path` in the workspace. A missing file counts as stale.
 *
 * @param {string} path Workspace-relative output path.
 * @param {string} digest Digest of the tree holding the generated `path`.
 * @returns {boolean}
 */
export function generatedFileIsStale(path, digest) {
	const before = digestOf(file_set.literal([path]));
	const changes = diffDigests(before, digest);
	// diffDigests stops descending once a whole subtree is uniformly added or
	// removed (e.g. the destination directory didn't exist at all before a
	// first run), reporting that shallow ancestor rather than each leaf file
	// under it. Since `path` is already the exact leaf we care about, treat it
	// as changed if any diff entry is that path itself or an ancestor of it.
	return changes.some(
		(change) => change.path === path || path.startsWith(`${change.path}/`),
	);
}
