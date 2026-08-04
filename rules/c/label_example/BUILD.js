// A bespoke build can live entirely in its BUILD file. Source
// discovery and branching happen lazily below the selected label; compile and
// link are ordinary memoized functions rather than target products.
import {
	build,
	glob,
	label,
	logInfo,
	memo,
	mergeDigests,
	output,
	output_path,
	packageGoal,
	paths,
	run,
	test,
	writeWorkspace,
	group,
} from "imp:core";
import { defaultGccToolchainVersion, gccTool } from "//rules/c/gcc";
import { jsSources } from "//rules/js";
import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";

function scopeOf(selector) {
	const address = selector.replace(/^\/\//, "");
	const colon = address.lastIndexOf(":");
	return colon < 0 ? address : address.slice(0, colon);
}

function objectPath(source) {
	return `build/c-label/${source.replace(/[^A-Za-z0-9_.-]/g, "_")}.o`;
}

const compile = memo(
	async function compile(source, root) {
		const object = objectPath(source);
		const compiler = /\.(cc|cpp|cxx)$/.test(source) ? "c++" : "clang";
		const script = 'mkdir -p "$(dirname "$1")" && "$2" -c "$3" -o "$1"';
		const result = await run({
			argv: ["sh", "-c", script, "c-label-compile", object, compiler, source],
			tools: [
				await gccTool(defaultGccToolchainVersion()),
				await nativeToolSpec(nativeTool("dirname")),
				await nativeToolSpec(nativeTool("mkdir")),
			],
			inputs: [
				{ kind: "file", path: source },
				glob({ root, include: ["**/*.h", "**/*.hh", "**/*.hpp"] }),
			],
			outputs: [output(output_path(object))],
			materialize: false,
			display: `compile ${source} with ${compiler}`,
		});
		return { source, object, digest: result.outputDigest };
	},
	{ display: "C label compile {0}", level: "info" },
);

const link = memo(
	async function link(objects) {
		const outputPath = "build/c-label/hasher";
		const digest = mergeDigests(objects.map((object) => object.digest));
		const script =
			'out=$1; shift; mkdir -p "$(dirname "$out")" && c++ -o "$out" "$@"';
		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"c-label-link",
				outputPath,
				...objects.map((object) => object.object),
			],
			tools: [
				await gccTool(defaultGccToolchainVersion()),
				await nativeToolSpec(nativeTool("dirname")),
				await nativeToolSpec(nativeTool("mkdir")),
			],
			inputs: [{ kind: "digest", digest }],
			outputs: [output(output_path(outputPath))],
			materialize: false,
			display: "link bespoke C/C++ hasher",
		});
		return { ...result, outputPath };
	},
	{ display: "C label link", level: "info" },
);

const hasher = label();

async function buildHasher(ctx) {
	const root = scopeOf(ctx.selector);
	const sources = paths(
		glob({ root, include: ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx"] }),
	).sort();
	if (sources.length === 0) {
		throw new Error(`no C/C++ sources discovered under ${root}`);
	}
	const objects = await group(sources.map((source) => compile(source, root)));
	return link(objects);
}

build(hasher, buildHasher);

test(hasher, async function testHasher(ctx) {
	const built = await buildHasher(ctx);
	return run({
		argv: [`./${built.outputPath}`],
		inputs: [{ kind: "digest", digest: built.outputDigest }],
		display: "run bespoke C/C++ hasher test",
	});
});

packageGoal(hasher, async function packageHasher(ctx) {
	const built = await buildHasher(ctx);
	const destination = "dist/rules/c/label_example/hasher";
	writeWorkspace(destination, built.outputDigest, {
		from: built.outputPath.slice(0, built.outputPath.lastIndexOf("/")),
	});
	logInfo(`${ctx.selector}#package -> ${destination}`);
});

export { hasher };
export const js = jsSources({});
