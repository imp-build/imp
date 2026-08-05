import { BUILD, output, task } from "imp:core";

/**
 * Declare a graph artifact containing fixed text.
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
