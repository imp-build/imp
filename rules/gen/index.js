import {
	build as attachBuild,
	extensible,
	label,
	memo,
	output,
	output_path,
	run,
} from "imp:core";

const writeStampFile = memo(
	async function writeStampFile(stamp) {
		const { output: outputPath, text } = stamp.data;
		return run({
			argv: [
				"sh",
				"-c",
				'printf \'%s\\n\' "$2" > "$1"',
				"imp-stamp",
				output_path(outputPath),
				text,
			],
			outputs: [output(outputPath)],
			materialize: true,
			display: `write ${outputPath}`,
		});
	},
	{ display: "build {0}", level: "info" },
);

/**
 * Declare a label that writes fixed text to an output file.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.output Workspace-relative output path.
 * @param {string} opts.text Text to write.
 * @returns {object} Label handle.
 */
export const stampFile = extensible(function stampFile({
	output: outputPath,
	text,
}) {
	const stamp = label({ data: { output: outputPath, text } });
	attachBuild(stamp, async function buildStampFile() {
		return writeStampFile(stamp);
	});
	return stamp;
});
