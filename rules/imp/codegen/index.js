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
