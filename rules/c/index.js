import {
	allUnowned,
	artifact,
	build,
	configuration,
	defineConfigSchema,
	extensible,
	field,
	glob,
	label,
	labelAddress,
	logInfo,
	memo,
	mergeDigests,
	output,
	output_path,
	packageGoal,
	paths,
	product,
	productFor,
	read_file,
	registerBuildRule,
	run,
	targetAddress,
	writeWorkspace,
} from "imp:core";

import { registerBuildGenerator } from "//rules/workflows/generate_build";
import { CC_TOOLCHAIN } from "//rules/c/products";
import { GCC_TOOL } from "//rules/c/gcc";
import { ZIG_TOOL } from "//rules/c/zig";

/**
 * Declarative workspace configuration schema for C/C++.
 *
 * `buildGenerate` enables `imp goal generate-build` for unowned
 * CMakeLists.txt/source files (off by default).
 */
export const cConfigSchema = {
	buildGenerate: field.bool({ default: false }),
};

defineConfigSchema("c", cConfigSchema);

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
import { defaultGccToolchain, gccTool, GccToolchain } from "//rules/c/gcc";
import {
	defaultZigToolchain,
	zigBuildCacheTool,
	zigGlobalCacheEnv,
	zigTool,
	ZigToolchain,
} from "//rules/c/zig";

// Generated BUILD.js files can reference these rule names regardless of which
// module implements the target constructor.
registerBuildRule({ rule: "ccLibrary", importFrom: "//rules/c" });
registerBuildRule({ rule: "ccBinary", importFrom: "//rules/c" });
registerBuildRule({ rule: "cmakeLib", importFrom: "//rules/c/cmake" });

export const DEFAULT_CPP_SRCS = ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx"];

export const DEFAULT_CPP_HDRS = ["**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx"];

const DEFAULT_GENERATE_BUILD_EXCLUDES = [
	"**/.*/**",
	"**/build/**",
	"**/coverage/**",
	"**/dist/**",
	"**/obj/**",
	"**/target/**",
	"**/vendor/**",
];

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`C/C++ paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle) return null;
	try {
		if (handle.__imp_label === true) return labelAddress(handle);
		if (handle.label?.__imp_label === true) return labelAddress(handle.label);
		if (handle.__imp === true) return targetAddress(handle);
		return null;
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = safe_target_address(handle);
	if (!address || !address.startsWith("//")) return ".";
	const scope = address.slice(2).split(":")[0];
	return scope.length === 0 ? "." : scope;
}

export function declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

function dirname(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

function basename(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? path : path.slice(index + 1);
}

function build_file_for_dir(dir) {
	return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function sanitize_identifier(raw) {
	let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
	if (name.length === 0) name = "root";
	if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
	return name;
}

function target_name_for_dir(dir) {
	if (dir === ".") return "root";
	return sanitize_identifier(basename(dir));
}

function append_build_target(result, file, target) {
	if (!result[file]) result[file] = [];
	result[file].push(target);
}

function normalize_deps(deps) {
	return deps
		.map((d) =>
			d && (d.__imp || d.__imp_label) ? d : d && d.target ? d.target : null,
		)
		.filter(Boolean);
}

function source_ext(path) {
	const match = /\.([^.\/]+)$/.exec(path);
	return match ? match[1].toLowerCase() : "";
}

function is_cxx_source(path) {
	return ["cc", "cpp", "cxx"].includes(source_ext(path));
}

function object_path_for(handle, source) {
	const name = source.replace(/[^A-Za-z0-9_.-]/g, "_");
	return `build/c/obj/${c_output_slug(handle)}/${name}.o`;
}

function default_output_path(handle, extension) {
	return `build/c/${c_output_slug(handle)}${extension}`;
}

function c_output_slug(handle) {
	const address = safe_target_address(handle);
	return address
		? address.replace(/^\/\//, "").replace(/[:/]/g, "_")
		: `anon-${handle.__id}`;
}

function shell_quote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function strip_c_comments_and_strings(input) {
	let out = "";
	let i = 0;
	let inString = false;
	let inChar = false;
	let inLineComment = false;
	let blockDepth = 0;

	while (i < input.length) {
		const ch = input[i];
		const next = input[i + 1];

		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out += "\n";
			} else {
				out += " ";
			}
			i++;
			continue;
		}

		if (blockDepth > 0) {
			if (ch === "/" && next === "*") {
				blockDepth++;
				out += "  ";
				i += 2;
			} else if (ch === "*" && next === "/") {
				blockDepth--;
				out += "  ";
				i += 2;
			} else {
				out += ch === "\n" ? "\n" : " ";
				i++;
			}
			continue;
		}

		if (!inString && !inChar && ch === "/" && next === "/") {
			inLineComment = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (!inString && !inChar && ch === "/" && next === "*") {
			blockDepth = 1;
			out += "  ";
			i += 2;
			continue;
		}

		if (inString || inChar) {
			out += ch === "\n" ? "\n" : " ";
			if (ch === "\\" && next !== undefined) {
				out += next === "\n" ? "\n" : " ";
				i += 2;
				continue;
			}
			if (inString && ch === '"') inString = false;
			if (inChar && ch === "'") inChar = false;
			i++;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += " ";
			i++;
			continue;
		}
		if (ch === "'") {
			inChar = true;
			out += " ";
			i++;
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

export function has_c_main_entrypoint(sourceText) {
	const text = strip_c_comments_and_strings(sourceText);
	return /(?:^|[^\w])main\s*\(/m.test(text);
}

const _ccLabels = [];
const _cmakeProjectLabels = [];

export function registerCmakeProjectLabel(project) {
	_cmakeProjectLabels.push(project);
}

export function ccActionHandle(handle) {
	if (!handle || handle.__imp_label !== true) return handle;
	return {
		__id: handle.__id,
		label: handle,
		attrs: handle.data,
		deps: [
			...(handle.data.deps || []).map((dep) => ({ handle: dep })),
			...(handle.data.toolchain
				? [{ handle: handle.data.toolchain, mode: "tool" }]
				: []),
		],
	};
}

export function ccWorkloadHandles() {
	return _ccLabels
		.map(ccActionHandle)
		.sort((a, b) =>
			(safe_target_address(a) || "").localeCompare(
				safe_target_address(b) || "",
			),
		);
}

async function publishCcPackage(workload, artifactResult) {
	if (artifactResult == null) return null;
	const address = labelAddress(workload);
	const withoutSlashes = address.replace(/^\/\//, "");
	const [dir, name] = withoutSlashes.split(":");
	const destination = dir ? `dist/${dir}/${name}` : `dist/${name}`;
	writeWorkspace(destination, artifactResult.digest, {
		from: artifactResult.from,
	});
	logInfo(`${address}#package -> ${destination}`);
	return artifactResult;
}

function createCcWorkload(type, opts = {}) {
	const {
		path = ".",
		srcs = DEFAULT_CPP_SRCS,
		hdrs = DEFAULT_CPP_HDRS,
		deps = [],
		toolchain,
		copts = [],
		linkopts = [],
		output: out,
	} = opts;
	if (toolchain && toolchain.__imp !== true) {
		throw new Error(
			"ccLibrary/ccBinary toolchain must be a target handle providing cc-toolchain",
		);
	}
	const toolchainHandle =
		toolchain || defaultZigToolchain() || defaultGccToolchain() || null;
	const workload = label({
		data: {
			type,
			backend: "raw",
			path,
			srcs: [...srcs],
			hdrs: [...hdrs],
			deps: normalize_deps(deps),
			copts: [...copts],
			linkopts: [...linkopts],
			...(out ? { output: out } : {}),
			...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
		},
	});
	_ccLabels.push(workload);
	build(workload, async function buildCcWorkload() {
		return ccBuild(workload);
	});
	packageGoal(workload, async function packageCcWorkload() {
		return publishCcPackage(workload, await ccPackage(workload));
	});
	return workload;
}

/** Declare a raw C/C++ library label. */
export const ccLibrary = extensible(function ccLibrary(opts = {}) {
	return createCcWorkload("library", opts);
});

/** Declare a raw C/C++ binary label. */
export const ccBinary = extensible(function ccBinary(opts = {}) {
	return createCcWorkload("binary", opts);
});

export const own_sources = memo(
	async function own_sources(handle) {
		handle = ccActionHandle(handle);
		return glob({
			root: declared_path(handle, handle.attrs.path || "."),
			include: handle.attrs.srcs || DEFAULT_CPP_SRCS,
		});
	},
	{ display: "own sources {0}", level: "debug" },
);

const headers = memo(
	async function headers(handle) {
		handle = ccActionHandle(handle);
		return glob({
			root: declared_path(handle, handle.attrs.path || "."),
			include: handle.attrs.hdrs || DEFAULT_CPP_HDRS,
		});
	},
	{ display: "headers {0}", level: "debug" },
);

class GccCcToolchain {
	constructor(handle) {
		this.handle = handle;
	}

	async tools() {
		return [
			await nativeToolSpec(nativeTool("dirname")),
			await nativeToolSpec(nativeTool("mkdir")),
			await gccTool(this.handle.attrs.version),
		];
	}

	env() {
		return [];
	}

	compiler(source) {
		return is_cxx_source(source) ? ["c++"] : ["clang"];
	}

	linker(needsCxx) {
		return needsCxx ? ["c++"] : ["clang"];
	}

	archiver() {
		return ["ar"];
	}
}

class ZigCcToolchain {
	constructor(handle) {
		this.handle = handle;
	}

	async tools() {
		return [
			await nativeToolSpec(nativeTool("dirname")),
			await nativeToolSpec(nativeTool("mkdir")),
			await zigTool(this.handle.attrs.version),
			await zigBuildCacheTool(this.handle.attrs.version),
		];
	}

	env() {
		return zigGlobalCacheEnv();
	}

	compiler(source) {
		return is_cxx_source(source) ? ["zig", "c++"] : ["zig", "cc"];
	}

	linker(needsCxx) {
		return needsCxx ? ["zig", "c++"] : ["zig", "cc"];
	}

	archiver() {
		return ["zig", "ar"];
	}
}

product(
	GccToolchain,
	CC_TOOLCHAIN,
	GCC_TOOL,
	(handle) => new GccCcToolchain(handle),
	{ display: "cc toolchain {0}", level: "info" },
);
product(
	ZigToolchain,
	CC_TOOLCHAIN,
	ZIG_TOOL,
	(handle) => new ZigCcToolchain(handle),
	{ display: "cc toolchain {0}", level: "info" },
);

async function ccToolchainFor(handle) {
	handle = ccActionHandle(handle);
	const toolchain =
		handle.attrs.toolchain || defaultZigToolchain() || defaultGccToolchain();
	if (!toolchain) {
		throw new Error(
			"C/C++ builds need an explicit toolchain or an imported zig/gcc rule default",
		);
	}
	return productFor(toolchain, CC_TOOLCHAIN);
}

// Compiles each source to its own object file, sandboxed and cached
// (materialize:false) rather than writing straight into the workspace — the
// per-object outputDigest is merged (via mergeDigests) into one tree digest
// covering every compiled object, so buildRawLibrary/buildRawBinary can pass
// that single merged digest as a `{kind:"digest"}` input to their own run()
// (staged at each object's original declared path) instead of depending on
// the objects being physically present on disk.
async function compileRawObjects(handle, toolchain) {
	const memoHandle = handle.label || handle;
	const sourcePaths = paths(await own_sources(memoHandle));
	const headerInputs = await headers(memoHandle);
	const tools = await toolchain.tools();
	const env = toolchain.env();
	const objects = [];
	const digests = [];
	const mode = configuration("imp.mode", {}) || {};
	const optFlags = mode.opt === "release" ? ["-O2", "-DNDEBUG"] : ["-O0", "-g"];

	for (const source of sourcePaths) {
		const obj = object_path_for(handle, source);
		const compiler = toolchain.compiler(source);
		const args = [
			...compiler,
			"-c",
			source,
			"-o",
			obj,
			...optFlags,
			...(handle.attrs.copts || []),
		];
		const script = `mkdir -p "$(dirname "$1")" && shift && "$@"`;
		const result = await run({
			argv: ["sh", "-c", script, "cc-compile", obj, ...args],
			tools,
			env,
			inputs: [{ kind: "file", path: source }, headerInputs],
			outputs: [output(output_path(obj))],
			materialize: false,
			display: `cc compile ${source}`,
		});
		objects.push({ source, object: obj });
		digests.push(result.outputDigest);
	}

	return { objects, digest: digests.length > 0 ? mergeDigests(digests) : null };
}

// Returns `{ paths, digest }`: the dependency's final link artifact's
// workspace-relative path(s) (used as argv filenames — a linker still needs
// real names, even for sandbox-staged, never-materialized files) and its CAS
// digest (already known from the dependency's own run() result — no
// filesystem capture needed, unlike a FileSet, which would require the
// artifact to already be materialized on disk).
export const cc_link_artifacts = memo(
	async function cc_link_artifacts(handle) {
		handle = ccActionHandle(handle);
		if (handle.attrs.backend === "cmake") {
			const cmake = await import("//rules/c/cmake");
			return cmake.cmake_link_artifacts(handle);
		}
		const result = await ccBuild(handle.label || handle);
		return result && result.outputPath
			? { paths: [result.outputPath], digest: result.outputDigest }
			: { paths: [], digest: null };
	},
	{ display: "cc link artifacts {0}", level: "debug" },
);

async function buildRawLibrary(handle) {
	handle = ccActionHandle(handle);
	const toolchain = await ccToolchainFor(handle);
	const { objects, digest } = await compileRawObjects(handle, toolchain);
	const outPath = handle.attrs.output || default_output_path(handle, ".a");
	const tools = await toolchain.tools();
	const env = toolchain.env();
	const ar = toolchain.archiver();
	const objectPaths = objects.map((obj) => obj.object);
	const script = `mkdir -p "$(dirname "$1")" && ${ar.map(shell_quote).join(" ")} rcs "$1" ${objectPaths.map(shell_quote).join(" ")}`;
	const result = await run({
		argv: ["sh", "-c", script, "cc-archive", outPath],
		tools,
		env,
		inputs: digest ? [{ kind: "digest", digest }] : [],
		outputs: [output(output_path(outPath))],
		materialize: false,
		display: `cc archive ${outPath}`,
	});
	result.outputPath = outPath;
	return result;
}

// Merges every `cc_library` dep's `{paths, digest}` into one combined
// `{paths, digest}` — the digest-chained analog of the old file_set.union()
// over each dep's materialized archive.
async function depLinkArtifacts(handle) {
	handle = ccActionHandle(handle);
	const artifacts = [];
	for (const dep of (handle.attrs.deps || []).filter(
		(h) =>
			h &&
			((h.__imp_label && h.data?.type === "library") ||
				h.kind === "cc_library"),
	)) {
		artifacts.push(await cc_link_artifacts(dep));
	}
	const allPaths = artifacts.flatMap((a) => a.paths);
	const digests = artifacts.map((a) => a.digest).filter((d) => d != null);
	return {
		paths: allPaths,
		digest: digests.length > 0 ? mergeDigests(digests) : null,
	};
}

async function buildRawBinary(handle) {
	handle = ccActionHandle(handle);
	const toolchain = await ccToolchainFor(handle);
	const { objects, digest } = await compileRawObjects(handle, toolchain);
	const linkInputs = await depLinkArtifacts(handle);
	const outPath = handle.attrs.output || default_output_path(handle, "");
	const tools = await toolchain.tools();
	const env = toolchain.env();
	const sourcePaths = objects.map((obj) => obj.source);
	const needsCxx = sourcePaths.some(is_cxx_source);
	const linker = toolchain.linker(needsCxx);
	const objectPaths = objects.map((obj) => obj.object);
	const linkPaths = linkInputs.paths;
	const script = `mkdir -p "$(dirname "$1")" && ${linker.map(shell_quote).join(" ")} -o "$1" ${objectPaths.map(shell_quote).join(" ")} ${linkPaths.map(shell_quote).join(" ")} ${(handle.attrs.linkopts || []).map(shell_quote).join(" ")}`;
	const result = await run({
		argv: ["sh", "-c", script, "cc-link", outPath],
		tools,
		env,
		inputs: [
			...(digest ? [{ kind: "digest", digest }] : []),
			...(linkInputs.digest
				? [{ kind: "digest", digest: linkInputs.digest }]
				: []),
		],
		outputs: [output(output_path(outPath))],
		materialize: false,
		display: `cc link ${outPath}`,
	});
	result.outputPath = outPath;
	return result;
}

export const ccBuild = memo(
	async function ccBuild(handle) {
		handle = ccActionHandle(handle);
		if (handle.attrs.backend === "cmake") {
			const cmake = await import("//rules/c/cmake");
			return cmake.buildCmakeArtifact(handle);
		}
		return handle.attrs.type === "library"
			? buildRawLibrary(handle)
			: buildRawBinary(handle);
	},
	{ display: "build {0}", level: "info" },
);

export const ccPackage = memo(
	async function ccPackage(handle) {
		handle = ccActionHandle(handle);
		if (handle.attrs.backend === "cmake") {
			const cmake = await import("//rules/c/cmake");
			return cmake.packageCmakeArtifact(handle);
		}
		const result =
			handle.attrs.type === "library"
				? await buildRawLibrary(handle)
				: await buildRawBinary(handle);
		return artifact(result.outputDigest, { from: dirname(result.outputPath) });
	},
	{ display: "package {0}", level: "info" },
);

function path_is_under(path, root) {
	const normalizedPath = normalize_workspace_path(path);
	const normalizedRoot = normalize_workspace_path(root);
	return normalizedRoot === "."
		? normalizedPath !== "."
		: normalizedPath === normalizedRoot ||
				normalizedPath.startsWith(`${normalizedRoot}/`);
}

function source_has_main(path) {
	if (!["c", "cc", "cpp", "cxx"].includes(source_ext(path))) return false;
	return has_c_main_entrypoint(read_file(path));
}

export async function generateBuild({
	root = ".",
	exclude = DEFAULT_GENERATE_BUILD_EXCLUDES,
} = {}) {
	const files = allUnowned({
		root,
		include: ["**/CMakeLists.txt", ...DEFAULT_CPP_SRCS, ...DEFAULT_CPP_HDRS],
		exclude,
	});

	const existingPaths = new Set([
		...ccWorkloadHandles().map((h) =>
			normalize_workspace_path(declared_path(h, h.attrs.path || ".")),
		),
		..._cmakeProjectLabels
			.map((project) => ccActionHandle(project))
			.map((h) =>
				normalize_workspace_path(declared_path(h, h.attrs.src || ".")),
			),
	]);

	const cmakeDirs = Array.from(
		new Set(
			files.filter((path) => basename(path) === "CMakeLists.txt").map(dirname),
		),
	).sort();

	const result = {};
	for (const dir of cmakeDirs) {
		if (existingPaths.has(normalize_workspace_path(dir))) continue;
		append_build_target(result, build_file_for_dir(dir), {
			name: `${target_name_for_dir(dir)}_cmake`,
			rule: "cmakeLib",
			props: {},
		});
	}

	const cmakeRoots = cmakeDirs.filter(
		(dir) => !existingPaths.has(normalize_workspace_path(dir)),
	);
	const rawSources = files
		.filter((path) => ["c", "cc", "cpp", "cxx"].includes(source_ext(path)))
		.filter((path) => !cmakeRoots.some((root) => path_is_under(path, root)));

	const rawDirs = Array.from(new Set(rawSources.map(dirname))).sort();
	for (const dir of rawDirs) {
		if (existingPaths.has(normalize_workspace_path(dir))) continue;
		const dirSources = rawSources.filter((path) => dirname(path) === dir);
		const hasMain = dirSources.some(source_has_main);
		append_build_target(result, build_file_for_dir(dir), {
			name: target_name_for_dir(dir),
			rule: hasMain ? "ccBinary" : "ccLibrary",
			props: {},
		});
	}

	return result;
}

registerBuildGenerator({ namespace: "c", generate: generateBuild });
