import { FMT } from "//rules/workflows/fmt";
import { digestOf, output, semantic, task } from "imp:core";
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
	const formatter = odinfmtGraphTool(version);
	return task({
		display: `odinfmt ${base}`,
		inputs: {
			sources,
			formatter,
			check: semantic.flag("check"),
			shell,
		},
		outputs: { result: output.value() },
		async run(exec, inputs) {
			// inputs.sources is the package's declared srcs glob, which isn't
			// always `.odin`-only in practice: odin has no way to pick up a
			// dep's sources when compiling except by pointing a collection at
			// a real directory, so some packages work around that by widening
			// their own srcs glob to sweep a vendored tree's files (including
			// non-.odin ones) into their sources. odinfmt only understands
			// `.odin` files, so filter to those before formatting.
			const paths = exec
				.paths(inputs.sources)
				.filter((path) => path.endsWith(".odin"));
			if (paths.length === 0) {
				return {
					result: {
						formatted: null,
						paths,
						check: { requested: inputs.check, failed: false },
					},
				};
			}
			const command = exec.tool(
				inputs.formatter,
				odinfmtCommandName(platformInfo()),
			);
			// Formats in place — the sandbox's mounted inputs are writable, not
			// read-only, so odinfmt can rewrite paths directly. Unlike ruff/biome
			// (which natively refuse to write under --check and report a
			// failed exit code instead), odinfmt has no such mode: it always
			// writes, so whether a --check run "fails" is derived the same way
			// "changed" is in write mode — a real diffDigests() comparison
			// against sourcesDigest, done centrally in graphFmtGoal's
			// unitStatus() rather than the shell's own cmp — so this task
			// itself never needs to know whether --check was requested.
			// odinfmt's CLI takes exactly one [path] argument (a single file or
			// a directory), never a list of files, so each declared source is
			// formatted with its own invocation. A single directory argument
			// (base) would be simpler, but odinfmt walks it recursively, and the
			// sandbox root also holds whatever else this run mounted (e.g. the
			// toolchain's own bundled builtin/*.odin files); for a root-declared
			// package (base === ".") that swept up and reformatted the
			// toolchain's own files too. Looping per-file keeps this scoped to
			// exactly the package's declared sources.
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'formatter=$1; shift; status=0; for path in "$@"; do "$formatter" -w "$path" || status=1; done; exit $status',
					"odinfmt",
					command,
					...paths,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell],
				outputs: { formatted: output.directory(base) },
				allowFailure: true,
			});
			return {
				result: {
					formatted: result.outputs.formatted,
					sourcesDigest: digestOf(inputs.sources.fileset),
					paths,
					check: { requested: inputs.check, failed: result.exitCode !== 0 },
					output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
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
