import { FMT, output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { registerOdinPackageHook } from "//rules/odin";
import {
	odinfmtGraphTool,
	odinfmtCommandName,
} from "//rules/odin/odinfmt/toolchain";
import { platformInfo } from "imp:core";

export {
	defaultOdinfmtToolchain,
	odinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";

/** Build the CAS formatter result consumed by the shared graph fmt workflow. */
export function odinFmtRoot({ sources, base, version }) {
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	const cmp = nativeTool("cmp");
	const formatter = odinfmtGraphTool(version);
	return task({
		display: `odinfmt ${base}`,
		inputs: {
			sources,
			formatter,
			check: semantic.flag("check"),
			shell,
			cp,
			mkdir,
			dirname,
			cmp,
		},
		outputs: { result: output.value() },
		async run(exec, inputs) {
			const paths = exec.paths(inputs.sources);
			if (paths.length === 0) {
				return {
					result: {
						formatted: (
							await exec.action({
								argv: [
									exec.tool(inputs.shell, "sh"),
									"-c",
									"mkdir -p formatted",
								],
								outputs: { formatted: output.directory("formatted") },
							})
						).outputs.formatted,
						paths,
						check: { requested: inputs.check, failed: false },
					},
				};
			}
			const command = exec.tool(
				inputs.formatter,
				odinfmtCommandName(platformInfo()),
			);
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'check=$1; formatter=$2; shift 2; for path in "$@"; do mkdir -p "formatted/$(dirname "$path")" && cp "$path" "formatted/$path"; done; cd formatted && "$formatter" -w "$@"; status=0; if [ "$check" = true ]; then for path in "$@"; do cmp -s "../$path" "$path" || status=1; done; fi; exit $status',
					"odinfmt",
					String(inputs.check),
					command,
					...paths,
				],
				inputs: [inputs.sources],
				tools: [
					inputs.shell,
					inputs.cp,
					inputs.mkdir,
					inputs.dirname,
					inputs.cmp,
				],
				outputs: { formatted: output.directory("formatted") },
				allowFailure: true,
			});
			return {
				result: {
					formatted: result.outputs.formatted,
					paths,
					check: { requested: inputs.check, failed: result.exitCode !== 0 },
				},
			};
		},
	});
}

// Workspace extensions load before BUILD files, so this makes every later
// Odin declaration complete and immutable without touching package callsites.
registerOdinPackageHook((source) => ({
	[FMT]: odinFmtRoot(source).outputs.result,
}));
