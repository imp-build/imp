// Generic in-graph source generation: run a generator in a sandboxed action and
// hand the outputs to a language rule as declared sources.
//
// This is the sibling of //rules/imp/generate's `generatedFiles()`. The two
// declare the same thing — files a command produces — and differ only in where
// those files go:
//
//   generatedFiles()  the workspace. The [GENERATE] contract behind
//                     `imp generate`, for committed, drift-gated codegen.
//   codegen()         the graph. Consumed by a package (e.g. odinPackage's
//                     `generatedSrcs`) and staged into its sandbox. Nothing
//                     lands on disk.
//
// That difference decides the return shape, which is the reason both exist.
// `generatedFiles()` returns one value handle carrying `{paths, files}`, which
// resolves at execution time — good enough for a goal that publishes at the
// workflow boundary. A package needs the artifact for a given path while the
// graph is still being CONSTRUCTED, so `codegen()` declares one output slot per
// path and returns those handles directly.
//
// The generator is an ordinary sandboxed action with declared tools. There is
// no JavaScript-callback form on purpose: it would run workspace code inside
// the build engine instead of in the sandbox. A JS generator is a command like
// any other — use `imp_self` as its argv[0] to invoke imp itself.
//
// `stampFile()` is the degenerate case of the same idea: the output is fixed
// text, so there is no generator command and no declared tool. It lives here
// because it produces a graph artifact, like `codegen()`.
import { output, task } from "imp:core";
import { BUILD } from "//rules/workflows/build";
import { planGeneratedOutputs } from "//rules/imp/generate";

/**
 * The contract a `codegen()` result carries, so a consuming rule can recognize
 * one and take every file it declares.
 *
 * Deliberately a plain symbol and not a `goal()`: nothing invokes codegen on
 * its own. It is built because a package depends on it, and `imp build` on the
 * target below builds it directly. Writing generated sources into the workspace
 * is `imp generate`'s job, and that is a different declaration.
 */
export const CODEGEN = Symbol.for("imp.codegen");

/**
 * Declare generated sources that live in the graph.
 *
 * ```js
 * import { codegen } from "//rules/imp/codegen";
 * import { nativeTool } from "//rules/imp/native-tool";
 * import { odinPackage } from "//rules/odin";
 * import { files } from "imp:core";
 *
 * const bindings = codegen({
 *     display: "generate Odin bindings",
 *     tools: { python3: nativeTool("python3") },
 *     inputs: { schema: files({ root: ".", include: ["schema.json"] }) },
 *     outputPaths: ["app/generated/bindings.odin"],
 *     argv: (exec, { python3 }) => [
 *         exec.tool(python3, "python3"),
 *         "tools/schema_to_odin.py",
 *         "schema.json",
 *         "app/generated/bindings.odin",
 *     ],
 * });
 *
 * export const app = odinPackage({
 *     path: "app",
 *     exclude: ["generated/bindings.odin"],
 *     generatedSrcs: [bindings],
 * });
 * ```
 *
 * `outputPaths` are workspace-relative, and they are the contract: a consuming
 * package stages each artifact at exactly that path, so one path must have one
 * owner. Exclude a generated path from any glob that would also claim it.
 *
 * A nested output path needs no `mkdir`. The executor creates the parent
 * directory of every declared file output before it starts the program.
 *
 * @param {object} opts
 * @param {string} [opts.display] Human-readable action label.
 * @param {object} [opts.tools] Named tool handles the generator needs.
 * @param {object} [opts.inputs] Named source handles the generator reads.
 * @param {string[]} opts.outputPaths Workspace-relative paths the generator writes.
 * @param {(exec: object, inputs: object) => string[]} opts.argv Builds the
 *   generator command line from the resolved tools/inputs.
 * @returns {object} Frozen `{paths, files, [CODEGEN], [BUILD]}`, where
 *   `files[path]` is the artifact handle for that output path.
 */
export function codegen({
	display,
	tools = {},
	inputs = {},
	outputPaths,
	argv,
}) {
	const { toolNames, inputNames, slots } = planGeneratedOutputs("codegen", {
		tools,
		inputs,
		outputPaths,
		argv,
	});
	const generated = task({
		display: display || `generate ${outputPaths.join(" ")}`,
		inputs: { ...tools, ...inputs, outputPaths },
		outputs: Object.fromEntries(slots.map((slot) => [slot, output.artifact()])),
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
			return Object.fromEntries(
				slots.map((slot) => [slot, action.outputs[slot]]),
			);
		},
	});
	const files = Object.fromEntries(
		outputPaths.map((path, index) => [path, generated.outputs[slots[index]]]),
	);
	return Object.freeze({
		paths: Object.freeze([...outputPaths]),
		files: Object.freeze(files),
		[CODEGEN]: true,
		// A bare completion handle: `imp build` on this target runs the
		// generator and warms the cache, and writes nothing to the workspace.
		[BUILD]: generated,
	});
}

/**
 * Normalize a rule's `generatedSrcs` list into the one shape the staging
 * contract is written in: `[{ artifact, expectedPath }]`, where `expectedPath`
 * is the workspace-relative path the artifact must land at.
 *
 * An entry is either a `codegen()` result — expanded to one pair per declared
 * output path — or the bare `{ artifact, path }` form. `resolvePath` maps a
 * bare entry's rule-relative `path` onto a workspace-relative one; its default
 * is identity, which is also what a `codegen()` result already carries.
 *
 * Internal to the language rules that consume generated sources
 * (`odinPackage`, `ccLibrary`/`ccBinary`, ...); not part of the public API.
 *
 * @param {Array<object>} entries The rule's `generatedSrcs` option.
 * @param {object} opts
 * @param {string} opts.rule Consuming rule name, for error messages.
 * @param {(path: string) => string} [opts.resolvePath] Maps a bare entry's
 *   `path` to its workspace-relative form. Default: identity.
 * @returns {Array<{artifact: object, expectedPath: string}>}
 */
export function normalizeGeneratedSrcs(
	entries,
	{ rule, resolvePath = (path) => path } = {},
) {
	return (entries || []).flatMap((entry, index) => {
		if (entry?.[CODEGEN] === true) {
			return entry.paths.map((expectedPath) => ({
				artifact: entry.files[expectedPath],
				expectedPath,
			}));
		}
		if (entry?.artifact?.__imp_graph_handle !== true || !entry.path) {
			throw new Error(
				`${rule} generatedSrcs[${index}] must be a codegen() result, or ` +
					'{ artifact: <graph handle>, path: "<relative path>" }',
			);
		}
		return [
			{ artifact: entry.artifact, expectedPath: resolvePath(entry.path) },
		];
	});
}

/**
 * Collapse generated sources that share one workspace path, and reject a real
 * conflict: two *different* artifacts both claiming that path, which would
 * overwrite each other in the sandbox with the winner decided by input order.
 *
 * A rule that stages generated sources over a whole dependency closure (one
 * `odin build` compiles every package it reaches) runs the merged list through
 * this; a rule that stages only its own package still gets the within-list
 * dedupe.
 *
 * @param {Array<{artifact: object, expectedPath: string}>} list
 * @param {object} opts
 * @param {string} opts.rule Consuming rule name, for error messages.
 * @returns {Array<{artifact: object, expectedPath: string}>}
 */
export function dedupeGeneratedSrcs(list, { rule } = {}) {
	const byPath = new Map();
	for (const generated of list || []) {
		const current = byPath.get(generated.expectedPath);
		if (current === undefined) {
			byPath.set(generated.expectedPath, generated);
			continue;
		}
		if (current.artifact.__graph_id !== generated.artifact.__graph_id) {
			throw new Error(
				`${rule}: two different generated sources cannot claim one ` +
					`workspace path ('${generated.expectedPath}')`,
			);
		}
	}
	return [...byPath.values()];
}

/**
 * The run-time half of the staging contract: a generated source's artifact
 * must land at exactly the workspace path its entry declared, since a language
 * compiler only discovers files that are actually inside the package
 * directory. Called from a consuming rule's `run()` once the sandbox path is
 * known.
 *
 * @param {string} rule Consuming rule name, for the error message.
 * @param {number} index Position in the rule's `generatedSrcs`, for the message.
 * @param {string} actual The artifact's real sandbox path (`exec.path(handle)`).
 * @param {string} expected The declared workspace-relative output path.
 */
export function assertGeneratedSrcPath(rule, index, actual, expected) {
	if (actual !== expected) {
		throw new Error(
			`${rule} generatedSrcs[${index}] artifact's real path '${actual}' does ` +
				`not match its declared path ('${expected}') — the generating ` +
				"action's output.file() path must match",
		);
	}
}

/**
 * Declare a graph artifact containing fixed text.
 *
 * The degenerate `codegen()`: the content is a literal, so there is no
 * generator command and no declared tool. `argv[0]` is a bare `sh`, the
 * resolved built-in shell, not an undeclared tool.
 *
 * @category graph
 * @param {object} opts
 * @param {string} opts.output Workspace-relative output path.
 * @param {string} opts.text Text to write.
 * @returns {{file: object, [BUILD]: object}} Produced file artifact and build root.
 */
export function stampFile({
	output: outputPath,
	text,
}) {
	const stamp = task({
		display: `write ${outputPath}`,
		inputs: { outputPath, text },
		outputs: { file: output.artifact() },
		async run(exec, { outputPath, text }) {
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'printf \'%s\\n\' "$2" > "$1"',
					"imp-stamp",
					outputPath,
					text,
				],
				outputs: { file: output.file(outputPath) },
			});
			return { file: result.outputs.file };
		},
	});
	return Object.freeze({ file: stamp.outputs.file, [BUILD]: stamp.outputs.file });
}
