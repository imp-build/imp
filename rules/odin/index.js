import {
	field,
	defineConfigSchema,
	allUnowned,
	label,
	extensible,
	artifact,
	glob,
	file_set,
	paths,
	read_file,
	memo,
	output,
	output_path,
	productFor,
	registerBuildRule,
	run,
	configuration,
	labelAddress,
	targetAddress,
	targetRef,
	logInfo,
	writeWorkspace,
	runTemplate,
	runFromTemplate,
	build as attachBuild,
	test as attachTest,
	lint as attachLint,
	runGoal as attachRun,
	packageGoal as attachPackage,
} from "imp:core";
import { ODIN_LINKER } from "//rules/odin/products";

/**
 * Declarative workspace configuration schema for Odin.
 *
 * `collections` is a dynamic `map[string]string` from Odin collection names
 * to workspace-relative paths. For example:
 *
 *     export const odinConfig = {
 *         collections: { lib: "library" },
 *     };
 *
 * Package-local Odin collections use the `collections` option on
 * odinPackage/odinTestPackage instead and may include target handles or
 * `{ name, path }` entries.
 *
 * `buildGenerate` enables `imp goal generate-build` for unowned `.odin`
 * files (off by default).
 *
 */
export const odinConfigSchema = {
	collections: field.map(field.string(), field.string(), {
		default: {},
		example: { vendor: "//src/odin/vendor" },
	}),
	buildGenerate: field.bool({ default: false }),
};

defineConfigSchema("odin", odinConfigSchema);

import { registerBuildGenerator } from "//rules/workflows/generate_build";

import {
	defaultOdinToolchain,
	odinTool,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

import { resources as resource_package_sources } from "//rules/asset";

import { cmake_resources } from "//rules/c/cmake";

import { defaultGccToolchain, gccTool } from "//rules/c/gcc";

// Registers the "run" goal's callback (rules/workflows/run/index.js) for consumers
// that import Odin build rules without importing the workflows layer
// explicitly. Odin's own "run" goal handler is attached directly to each
// odinPackage() label below (see attachRun) and does not depend on this
// registration, but other, still-Target-based run products may.
import "//rules/workflows/run";

// Registers the "build" goal's artifact summary callback for consumers that
// import Odin build rules without importing the workflows layer explicitly.
import "//rules/workflows/build";
import { ODIN_TOOL } from "//rules/odin/toolchain";

export {
	acquireOdinToolchain,
	defaultOdinToolchain,
	defaultOdinToolchainVersion,
	odinArtifactName,
	odinBin,
	odinCacheKey,
	odinDownloadUrl,
	odinToolchain,
	odinTool,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

registerBuildRule({
	rule: "odinPackage",
	importFrom: "//rules/odin",
});

registerBuildRule({
	rule: "odinTestPackage",
	importFrom: "//rules/odin",
});

// ---------------------------------------------------------------------------
// Label handle helpers
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`Odin paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

// Returns the workspace address for either a label() handle, an
// odin_package_handle() action-handle wrapper around one, or a real Target
// handle (e.g. odinToolchain()) — or null when the handle is anonymous/
// unaddressed. Mirrors rules/rust/index.js's cargoPackageAddress.
function safe_address(handle) {
	if (!handle) return null;
	try {
		if (handle.__imp_label === true) return labelAddress(handle);
		if (handle.label && handle.label.__imp_label === true) {
			return labelAddress(handle.label);
		}
		if (handle.__imp === true) return targetAddress(handle);
	} catch (_) {
		// fall through
	}
	return null;
}

function declaring_directory(handle) {
	const address = safe_address(handle);
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

function package_srcs(attrs) {
	if (!attrs || attrs.srcs === undefined || attrs.srcs.length === 0)
		return ["*.odin"];
	return attrs.srcs;
}

function package_exclude(attrs) {
	if (!attrs || attrs.exclude === undefined) return [];
	return attrs.exclude;
}

function normalize_deps(deps) {
	return deps
		.map((d) =>
			d && (d.__imp === true || d.__imp_label === true)
				? d
				: d && d.target
					? d.target
					: null,
		)
		.filter(Boolean);
}

// `collections` may be target handles (see package_collection_entries)
// instead of plain `{ name, path }` config entries — when it is, those
// handles are real dependency edges (the collection's own package/sources
// must be built/present), so they need to be listed explicitly alongside
// toolchain/deps rather than left for attrs auto-discovery to find.
function collection_dep_handles(collections) {
	return Array.isArray(collections) &&
		collections.length > 0 &&
		collections.every((col) => col && col.__imp === true)
		? collections
		: [];
}

// odinPackage()/odinTestPackage()/odinGen() return bare label() handles,
// which carry no .kind and no dependency-edge list of their own (unlike the
// Target handles they replace). This wraps a label into an "action handle"
// shape — { __id, label, kind, attrs, deps } — that every helper below can
// keep reading the same way it read a Target handle's { attrs, deps, kind }.
// `kind` is synthesized from the label's own private __odinKind marker so
// that dependency-graph code walking a package's deps can keep comparing
// `dep.kind === "odin-package"` etc, unchanged, for both raw Target deps
// (resource-package, cmake-lib — untouched by this migration) and Odin's own
// label deps. Idempotent: passing an already-wrapped handle, or a real
// Target handle, returns it unchanged. Mirrors rules/rust/index.js's
// package_handle().
export function odin_package_handle(handle) {
	if (!handle || handle.__imp_label !== true) return handle;
	const data = handle.data;
	const kind =
		data.__odinKind === "package"
			? "odin-package"
			: data.__odinKind === "testPackage"
				? "odin-test-package"
				: "odin-gen";
	return {
		__id: handle.__id,
		label: handle,
		kind,
		attrs: data,
		deps: [
			...(data.toolchain ? [{ handle: data.toolchain, mode: "tool" }] : []),
			...(data.deps || []).map((target) => ({ handle: target })),
			...collection_dep_handles(data.collections).map((target) => ({
				handle: target,
			})),
		],
	};
}

/**
 * Return a FileSet of the package's own source files.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
function own_sources_value(handle) {
	return glob({
		root: declared_path(handle, handle.attrs.path || "."),
		include: package_srcs(handle.attrs),
		exclude: package_exclude(handle.attrs),
	});
}

export const own_sources = memo(
	async function own_sources(handle) {
		return own_sources_value(odin_package_handle(handle));
	},
	{ display: "own sources {0}", level: "debug" },
);

/**
 * Return a FileSet of the package's own sources plus all transitive odin-package dep sources.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const sources = memo(
	async function sources(handle) {
		const sets = await collect_source_sets(
			odin_package_handle(handle),
			new Set(),
		);
		return sets.length === 1 ? sets[0] : file_set.union(...sets);
	},
	{ display: "sources {0}", level: "debug" },
);

async function collect_source_sets(handle, seen) {
	handle = odin_package_handle(handle);
	const key = dep_key(handle);
	if (seen.has(key)) return [];
	seen.add(key);

	const sets = [own_sources_value(handle)];
	for (const dep of await effective_deps(handle)) {
		sets.push(...(await collect_source_sets(dep, seen)));
	}
	return sets;
}

/**
 * Return a FileSet of all resource-package dep files reachable from an Odin package.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<Array>} A list of run()-inputs entries — FileSets
 * (resource-package deps, real workspace files) and/or `{kind:"digest"}`
 * objects (cmake-lib deps, whose build output is never materialized) — to
 * be spread directly into a run()'s own `inputs` array.
 */
export const resources = memo(
	async function resources(handle) {
		return collect_resource_sets(odin_package_handle(handle), new Set());
	},
	{ display: "Odin resources {0}", level: "debug" },
);

async function collect_resource_sets(handle, seen) {
	handle = odin_package_handle(handle);
	const key = dep_key(handle);
	if (seen.has(key)) return [];
	seen.add(key);

	const sets = [];
	for (const rawDep of handle.deps.map((dep) => dep.handle)) {
		if (!rawDep) continue;
		const dep = odin_package_handle(rawDep);
		if (dep.kind === "resource-package") {
			sets.push(await resource_package_sources(dep));
		} else if (dep.kind === "cmake-lib") {
			sets.push(await cmake_resources(dep));
		}
	}
	for (const dep of await effective_deps(handle)) {
		sets.push(...(await collect_resource_sets(dep, seen)));
	}
	return sets;
}

function collection_entries_from_config(value, resolvePath) {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		return value.map((entry) => {
			if (
				!entry ||
				typeof entry.name !== "string" ||
				typeof entry.path !== "string"
			) {
				throw new Error(
					"Odin collection entries must have string name and path fields",
				);
			}
			return { name: entry.name, path: resolvePath(entry.path) };
		});
	}
	if (typeof value === "object") {
		return Object.entries(value).map(([name, spec]) => {
			const path = typeof spec === "string" ? spec : spec && spec.path;
			if (typeof path !== "string") {
				throw new Error(
					`Odin collection '${name}' must be a path string or { path } object`,
				);
			}
			return { name, path: resolvePath(path) };
		});
	}
	throw new Error("Odin collections config must be an object or array");
}

function package_collection_entries(handle) {
	const collections = handle.attrs.collections || [];
	if (
		Array.isArray(collections) &&
		collections.every((col) => col && col.__imp === true)
	) {
		return collections.map((col) => ({
			name: col.attrs.name,
			path: declared_path(col, col.attrs.path),
		}));
	}
	return collection_entries_from_config(collections, (path) =>
		declared_path(handle, path),
	);
}

function collection_map(handle = null) {
	const odinConfig = configuration("odin", {}) || {};
	const merged = new Map();
	for (const entry of collection_entries_from_config(
		odinConfig.collections || {},
		normalize_workspace_path,
	)) {
		merged.set(entry.name, entry.path);
	}
	if (handle) {
		for (const entry of package_collection_entries(handle)) {
			merged.set(entry.name, entry.path);
		}
	}
	return merged;
}

function has_collection_config(collections) {
	if (collections === null || collections === undefined) return false;
	if (Array.isArray(collections)) return collections.length > 0;
	if (typeof collections === "object")
		return Object.keys(collections).length > 0;
	return true;
}

/**
 * Return the `-collection:name=path` flags configured for an Odin package.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<string[]>}
 */
export const collection_flags = memo(
	async function collection_flags(handle) {
		handle = odin_package_handle(handle);
		return Array.from(
			collection_map(handle),
			([name, path]) => `-collection:${name}=${path}`,
		);
	},
	{ display: "collection flags {0}", level: "debug" },
);

export const collection_dirs = memo(
	async function collection_dirs(handle) {
		handle = odin_package_handle(handle);
		const seen = new Set();
		const dirs = [];
		for (const path of collection_map(handle).values()) {
			const normalized = normalize_workspace_path(path);
			if (normalized === "." || seen.has(normalized)) continue;
			seen.add(normalized);
			dirs.push(normalized);
		}
		return dirs;
	},
	{ display: "collection dirs {0}", level: "debug" },
);

function strip_odin_comments(input) {
	let out = "";
	let i = 0;
	let inString = false;
	let inRune = false;
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

		if (!inString && !inRune && ch === "/" && next === "/") {
			inLineComment = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (!inString && !inRune && ch === "/" && next === "*") {
			blockDepth = 1;
			out += "  ";
			i += 2;
			continue;
		}

		out += ch;

		if (ch === '"' && !inRune && input[i - 1] !== "\\") {
			inString = !inString;
		} else if (ch === "'" && !inString && input[i - 1] !== "\\") {
			inRune = !inRune;
		}

		i++;
	}

	return out;
}

export class OdinPackageAnalysis {
	constructor({
		sourceFiles = [],
		packagePath = ".",
		imports = [],
		collections = [],
		hasMainEntrypoint = false,
	} = {}) {
		this.sourceFiles = sourceFiles;
		this.packagePath = packagePath;
		this.imports = imports;
		this.collections = collections;
		this.hasMainEntrypoint = hasMainEntrypoint;
	}
}

function scan_odin_source(content) {
	const text = strip_odin_comments(content);
	const imports = [];
	const single = /^\s*import(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+"([^"]+)"/gm;
	for (const match of text.matchAll(single)) {
		imports.push(match[1]);
	}

	const blocks = /^\s*import\s*\(([\s\S]*?)^\s*\)/gm;
	for (const block of text.matchAll(blocks)) {
		const entry = /^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s+)?"([^"]+)"/gm;
		for (const match of block[1].matchAll(entry)) {
			imports.push(match[1]);
		}
	}

	const uniqueImports = Array.from(new Set(imports)).sort();
	const collections = Array.from(
		new Set(
			uniqueImports
				.map((imp) => {
					const index = imp.indexOf(":");
					return index > 0 ? imp.slice(0, index) : null;
				})
				.filter(Boolean),
		),
	).sort();
	const hasMainEntrypoint = /^\s*main\s*::\s*proc\s*\(/m.test(text);
	return new OdinPackageAnalysis({
		imports: uniqueImports,
		collections,
		hasMainEntrypoint,
	});
}

function workspace_join(base, path) {
	const parts = [];
	for (const part of `${base || "."}/${path || "."}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0)
				throw new Error(`Odin path escapes the workspace: ${base}/${path}`);
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function resolved_import_path(importPath, collections) {
	const index = importPath.indexOf(":");
	if (index <= 0) return null;
	const collection = importPath.slice(0, index);
	const relative = importPath.slice(index + 1);
	if (!collections.has(collection)) return null;
	return workspace_join(collections.get(collection), relative);
}

function package_source_paths(pkg) {
	return paths(
		glob({
			root: pkg.path,
			include: pkg.srcs || ["*.odin"],
			exclude: pkg.exclude || [],
		}),
	);
}

function analysis_for_package(pkg) {
	const sourceFiles = package_source_paths(pkg);
	const packagePath = infer_package_path(pkg, sourceFiles);
	const imports = new Set();
	const collections = new Set();
	let hasMainEntrypoint = false;
	for (const file of sourceFiles) {
		const analysis = scan_odin_source(read_file(file));
		for (const imp of analysis.imports) {
			imports.add(imp);
		}
		for (const collection of analysis.collections) {
			collections.add(collection);
		}
		hasMainEntrypoint = hasMainEntrypoint || analysis.hasMainEntrypoint;
	}
	return new OdinPackageAnalysis({
		sourceFiles,
		packagePath,
		imports: Array.from(imports).sort(),
		collections: Array.from(collections).sort(),
		hasMainEntrypoint,
	});
}

function infer_package_path(pkg, sourceFiles) {
	const declared = normalize_workspace_path(pkg.path || ".");
	if (sourceFiles.length === 0) return declared;

	const sourceDirs = Array.from(new Set(sourceFiles.map(dirname))).sort();
	if (sourceDirs.includes(declared)) return declared;
	if (sourceDirs.length === 1) return sourceDirs[0];

	throw new Error(
		`${pkg.address || "odinPackage"} source files are spread across multiple package directories under '${declared}': ${sourceDirs.join(", ")}. ` +
			"Set path to the directory passed to odin build, or split this into separate odinPackage targets.",
	);
}

function package_spec_from_handle(handle) {
	handle = odin_package_handle(handle);
	return {
		address: safe_address(handle),
		handle,
		path: declared_path(handle, handle.attrs.path || "."),
		srcs: package_srcs(handle.attrs),
		exclude: package_exclude(handle.attrs),
	};
}

function generated_address_for_dir(dir, name) {
	const module = dir === "." ? "//" : `//${dir}`;
	return `${module}:${name}`;
}

function generated_package_spec(dir) {
	const name = target_name_for_dir(dir);
	return {
		address: generated_address_for_dir(dir, name),
		handle: null,
		path: dir,
		srcs: ["*.odin"],
		exclude: ["*_test.odin", "test_*.odin"],
	};
}

function build_package_index(packages) {
	const index = new Map();
	for (const pkg of packages) {
		const path = normalize_workspace_path(pkg.path || ".");
		const entries = index.get(path) || [];
		if (entries.some((entry) => entry.address === pkg.address)) {
			continue;
		}
		entries.push(pkg);
		index.set(path, entries);
	}
	return index;
}

export const imports = memo(
	async function imports(handle) {
		return (await odinPackageAnalysis(handle)).imports;
	},
	{ display: "imports {0}", level: "debug" },
);

export const odinPackageAnalysis = memo(
	async function odinPackageAnalysis(handle) {
		handle = odin_package_handle(handle);
		return analysis_for_package(package_spec_from_handle(handle));
	},
	{ display: "odin Package Analysis {0}", level: "debug" },
);

// Labels declared so far by odinPackage()/odinTestPackage(), in declaration
// order. Backs both dependency-inference's package_index() (below) and
// generate-build's existing-package dedup — labels have no workspace-wide
// enumeration API of their own (unlike workspaceTargets(kind) for Target
// subclasses), so each reusable factory tracks its own instances. Mirrors
// rules/rust/index.js's _cargoPackageLabels/cargoPackageHandles().
const _odinPackageLabels = [];
const _odinTestPackageLabels = [];

/**
 * Every odinPackage() label declared in the workspace so far, as
 * action-handle wrappers sorted by address. For consumers (e.g.
 * rules/workflows/vs.js) that used to enumerate `workspaceTargets("odin-package")`.
 *
 * @returns {Array<object>}
 */
export function odinPackageHandles() {
	return _odinPackageLabels
		.map(odin_package_handle)
		.sort((a, b) =>
			(safe_address(a) || "").localeCompare(safe_address(b) || ""),
		);
}

export const package_index = memo(
	async function package_index() {
		return build_package_index(
			_odinPackageLabels.map(package_spec_from_handle),
		);
	},
	{ display: "package index", level: "debug" },
);

function same_package(left, right) {
	if (!left || !right) return false;
	if (left.address && right.address && left.address === right.address)
		return true;
	if (left.handle && right.handle && left.handle.__id === right.handle.__id)
		return true;
	return (
		normalize_workspace_path(left.path || ".") ===
		normalize_workspace_path(right.path || ".")
	);
}

function lookup_package(index, path, selfPkg = null) {
	const candidates = (index.get(normalize_workspace_path(path)) || []).filter(
		(pkg) => !same_package(pkg, selfPkg),
	);
	if (candidates.length > 1) {
		const labels = candidates.map((pkg) => pkg.address).join(", ");
		throw new Error(
			`Odin import '${path}' resolves to multiple packages: ${labels}`,
		);
	}
	return candidates[0] || null;
}

function infer_dep_entries(
	pkg,
	index,
	collections,
	analysis = analysis_for_package(pkg),
) {
	const deps = new Map();
	for (const imp of analysis.imports) {
		let resolved;
		if (imp.includes(":")) {
			resolved = resolved_import_path(imp, collections);
		} else {
			resolved = workspace_join(analysis.packagePath, imp);
		}
		if (!resolved) continue;
		const dep = lookup_package(index, resolved, pkg);
		if (!dep) continue;
		deps.set(dep.address, dep);
	}
	return Array.from(deps.values()).sort((a, b) =>
		a.address.localeCompare(b.address),
	);
}

export const inferred_deps = memo(
	async function inferred_deps(handle) {
		handle = odin_package_handle(handle);
		const index = await package_index();
		const pkg = package_spec_from_handle(handle);
		const analysis = await odinPackageAnalysis(handle);
		return infer_dep_entries(pkg, index, collection_map(handle), analysis)
			.map((dep) => dep.handle)
			.filter(Boolean);
	},
	{ display: "inferred deps {0}", level: "debug" },
);

function dep_key(handle) {
	const address = safe_address(handle);
	return address || `#${handle.__id}`;
}

export const effective_deps = memo(
	async function effective_deps(handle) {
		handle = odin_package_handle(handle);
		const deps = new Map();
		for (const raw of handle.attrs.deps || []) {
			const dep = odin_package_handle(raw);
			if (dep.kind === "odin-package") deps.set(dep_key(dep), dep);
		}
		for (const dep of await inferred_deps(handle)) {
			deps.set(dep_key(dep), dep);
		}
		return Array.from(deps.values());
	},
	{ display: "effective deps {0}", level: "debug" },
);

/**
 * Acquire the Odin toolchain and return a tool spec for sandbox use.
 *
 * @param {object} handle Target handle returned by odinToolchain().
 * @returns {Promise<object>} Tool spec.
 */
export const tool = memo(
	async function tool(handle) {
		return odinTool(handle.attrs.version);
	},
	{ display: "tool {0}", level: "debug" },
);

// Stable, path-safe slug derived from a package label's own address — same
// role as the old Target-only targetOutputSlug(), reimplemented locally
// since labels have no shared engine-side equivalent. Mirrors
// rules/rust/index.js's cargoPackageOutputSlug.
function odinPackageOutputSlug(handle) {
	const address = safe_address(handle);
	return address
		? address.replace(/^\/\//, "").replace(/[:/]/g, "_")
		: `anon-${handle.__id}`;
}

export function default_output_path(handle) {
	return `build/odin/${odinPackageOutputSlug(odin_package_handle(handle))}`;
}

export function odin_output_path(out, analysis) {
	return analysis.hasMainEntrypoint ? out : `${out}.a`;
}

const DEFAULT_GENERATE_BUILD_EXCLUDES = [
	"**/.*/**",
	"**/build/**",
	"**/coverage/**",
	"**/dist/**",
	"**/obj/**",
	"**/target/**",
	"**/vendor/**",
];

function dirname(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

// The scope to publish/package alongside a built binary: its containing
// directory (so runtime siblings such as a .so travel with it), or — when
// the output has no directory component at all (it lands at the workspace
// root) — the file path itself, since "." is not a valid artifact/write
// scope and there's no meaningful sibling directory to bundle at the
// workspace root. Fixes #10 (the previous outDir computation truncated the
// last character of a directory-less output path instead of finding ".").
function build_output_scope(outputPath) {
	const dir = dirname(outputPath);
	return dir === "." ? outputPath : dir;
}

function basename(path) {
	if (path === ".") return "root";
	const index = path.lastIndexOf("/");
	return index < 0 ? path : path.slice(index + 1);
}

function target_name_for_dir(dir) {
	let name = basename(dir).replace(/[^A-Za-z0-9_$]/g, "_");
	if (name.length === 0) name = "root";
	if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
	return name;
}

function build_file_for_dir(dir) {
	return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function append_build_target(result, file, target) {
	if (!result[file]) result[file] = [];
	result[file].push(target);
}

function default_package_source_file(path) {
	const name = basename(path);
	return (
		name.endsWith(".odin") &&
		!name.endsWith("_test.odin") &&
		!name.startsWith("test_")
	);
}

function default_package_test_file(path) {
	const name = basename(path);
	return name.endsWith("_test.odin") || name.startsWith("test_");
}

function empty_package_error(handle, path) {
	const address = safe_address(handle) || "odinPackage";
	return (
		`${address} has no Odin source files after applying srcs/exclude filters at '${path}'. ` +
		"odinPackage excludes *_test.odin and test_*.odin by default; use odinTestPackage for package tests, or pass exclude: [] for a package that intentionally builds test files."
	);
}

// Odin needs a real gcc toolchain for both roles beyond its own compiler:
// `-build-mode:lib` uses its bundled binutils `ar`; linking an
// executable/test binary shells out to a program literally named `clang`,
// which in turn needs a real linker. By default no `-linker:` flag is
// passed, so clang's own default (gcc's bundled GNU ld/bfd) is used — its
// `-l:<namespec>` falls back to treating a full path as a literal file when
// it isn't found via -L search dirs (which is why Odin's own -l:<path>
// flags for local `foreign import` libraries resolve correctly against
// those). A workspace can opt into a faster linker (e.g. mold, which has
// the same forgiving behavior) via odinToolchain({ linker: moldToolchain() }).
// LLD lacks this forgiving behavior — and Zig's bundled LLD (via `zig cc`)
// can't be swapped out for a different linker either, it silently ignores
// -fuse-ld= — so Zig cannot serve as Odin's linker for packages linking a
// local .a/.so this way (confirmed empirically, not a documented LLD
// limitation). gcc's own ar covers the archiver role too, so Zig has no
// role left in Odin's build at all; it remains in use for CMake
// (rules/c/cmake), unaffected.
//
// gcc is downloaded/pinned (rules/c/gcc) rather than resolved from ambient
// PATH — importing the C/Odin rules provisions the default GCC toolchain.
async function odinScriptTools(handle, { needsDirname, isExecutable }) {
	const gcc = defaultGccToolchain();
	if (!gcc) {
		throw new Error(
			"Odin builds need the GCC rule default or an explicit linker — see //rules/c/gcc",
		);
	}
	const base = [
		await nativeToolSpec(nativeTool("mkdir")),
		...(needsDirname ? [await nativeToolSpec(nativeTool("dirname"))] : []),
	];
	if (!isExecutable) {
		return { tools: [...base, await gccTool(gcc.attrs.version)], flags: [] };
	}
	const toolchainHandle = handle.attrs.toolchain || defaultOdinToolchain();
	const linkerHandle = toolchainHandle && toolchainHandle.attrs.linker;
	if (!linkerHandle) {
		return { tools: [...base, await gccTool(gcc.attrs.version)], flags: [] };
	}
	const linker = await productFor(linkerHandle, ODIN_LINKER);
	return {
		tools: [
			...base,
			await gccTool(gcc.attrs.version),
			...(await linker.tools()),
		],
		flags: await linker.flags(),
	};
}

// ---------------------------------------------------------------------------
// Build/test/run/lint/package mechanics — ordinary memoized functions taking
// an odinPackage()/odinTestPackage()/odinGen() label (or its action-handle
// wrapper). Attached to their label's goal below.
// ---------------------------------------------------------------------------

/**
 * Build an Odin package.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<object>} Run result, plus `outputPath`: the built
 * binary/library's workspace-relative path.
 */
export const odinBuild = memo(
	async function odinBuild(handle) {
		handle = odin_package_handle(handle);
		const toolchainHandle = handle.attrs.toolchain;
		const odinToolSpec = toolchainHandle
			? await tool(toolchainHandle)
			: await odinTool(
					resolveOdinToolchainVersion(handle.attrs.toolchainVersion),
				);
		const srcs = await sources(handle);
		const genInputs = await collect_gen_sets(handle, new Set());
		const resourceInputs = await resources(handle);
		const flags = await collection_flags(handle);
		const collectionDirs = await collection_dirs(handle);
		const analysis = await odinPackageAnalysis(handle);
		if (analysis.sourceFiles.length === 0) {
			const packagePath = declared_path(handle, handle.attrs.path || ".");
			throw new Error(empty_package_error(handle, packagePath));
		}
		const mode = configuration("imp.mode", {}) || {};
		const optFlags = mode.opt === "release" ? ["-o:speed"] : ["-debug"];
		const modeFlags = analysis.hasMainEntrypoint ? [] : ["-build-mode:lib"];
		const path = analysis.packagePath;
		const out = handle.attrs.output || default_output_path(handle);
		const declaredOut = odin_output_path(out, analysis);
		const outputDir = dirname(out);
		const { tools: scriptTools, flags: linkerFlags } = await odinScriptTools(
			handle,
			{ needsDirname: true, isExecutable: analysis.hasMainEntrypoint },
		);
		const result = await run({
			argv: [
				"sh",
				"-c",
				'out=$1; pkg=$2; dir_count=$3; shift 3; mkdir -p "$(dirname "$out")"; while [ "$dir_count" -gt 0 ]; do mkdir -p "$1"; shift; dir_count=$((dir_count - 1)); done; odin build "$pkg" "-out:$out" "$@"',
				"odin-build",
				output_path(out),
				path,
				String(collectionDirs.length),
				...collectionDirs,
				...flags,
				...optFlags,
				...modeFlags,
				...linkerFlags,
			],
			tools: [odinToolSpec, ...scriptTools],
			inputs: [srcs, ...genInputs, ...resourceInputs],
			// Keep the executable as the first artifact for callers that use
			// outputPath, and also capture the complete output directory so
			// runtime siblings such as libjolt_odin.so travel with it — unless
			// the output has no directory component (it lands at the workspace
			// root), in which case "." isn't a valid artifact scope and there's
			// no meaningful sibling directory to bundle beyond the file itself.
			outputs: [
				output(declaredOut),
				...(outputDir === "."
					? []
					: [output(outputDir, { kind: "directory" })]),
			],
			materialize: false,
			display: `odin build ${path}`,
		});
		return { ...result, outputPath: declaredOut };
	},
	{ display: "build {0}", level: "info" },
);

export const odinTest = memo(
	async function odinTest(handle) {
		handle = odin_package_handle(handle);
		const toolchainHandle = handle.attrs.toolchain;
		const odinToolSpec = toolchainHandle
			? await tool(toolchainHandle)
			: await odinTool(
					resolveOdinToolchainVersion(handle.attrs.toolchainVersion),
				);
		const srcs = await sources(handle);
		const genInputs = await collect_gen_sets(handle, new Set());
		const resourceInputs = await resources(handle);
		const flags = await collection_flags(handle);
		const collectionDirs = await collection_dirs(handle);
		const analysis = await odinPackageAnalysis(handle);
		if (analysis.sourceFiles.length === 0) {
			const packagePath = declared_path(handle, handle.attrs.path || ".");
			throw new Error(empty_package_error(handle, packagePath));
		}
		const path = analysis.packagePath;
		const { tools: scriptTools, flags: linkerFlags } = await odinScriptTools(
			handle,
			{ needsDirname: false, isExecutable: true },
		);
		let outcome = run({
			argv: [
				"sh",
				"-c",
				'pkg=$1; dir_count=$2; shift 2; while [ "$dir_count" -gt 0 ]; do mkdir -p "$1"; shift; dir_count=$((dir_count - 1)); done; odin test "$pkg" "$@"',
				"odin-test",
				path,
				String(collectionDirs.length),
				...collectionDirs,
				...flags,
				...linkerFlags,
			],
			tools: [odinToolSpec, ...scriptTools],
			inputs: [srcs, ...genInputs, ...resourceInputs],
			// No impure flag: a passing run is cached and replayed on a
			// later run with unchanged inputs; a failing run bails before
			// any cache record is written, so it always reruns until it
			// passes.
			display: `odin test ${path}`,
		});
		logInfo(`Test finished: ${path}`);
		return outcome;
	},
	{ display: "test {0}", level: "info" },
);

/**
 * Build and execute an Odin package's binary directly against the real
 * workspace (not sandboxed) — the package must have a main entrypoint.
 * Unlike the old Target/product-based "run" goal, a label's "run" handler
 * (attached below, in odinPackage()) is dispatched directly and is not
 * gated by rules/workflows/run/index.js's single-target pre-flight check —
 * multi-selection rejection is therefore not enforced for label-based run
 * dispatch, matching the precedent set by rules/python/source.js's own
 * runGoal() handler.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @returns {Promise<object>} Run template.
 */
export const odinRun = memo(
	async function odinRun(handle) {
		handle = odin_package_handle(handle);
		const analysis = await odinPackageAnalysis(handle);
		if (!analysis.hasMainEntrypoint) {
			const path = declared_path(handle, handle.attrs.path || ".");
			throw new Error(
				`${path} has no main entrypoint; only executable odin-package targets can be run`,
			);
		}
		const buildResult = await odinBuild(handle);
		// odinBuild is materialize:false (sandboxed/cached only), so publish the
		// executable before returning the run template. The run goal starts the
		// program in the real workspace while retaining its sandboxed environment.
		const outDir = build_output_scope(buildResult.outputPath);
		writeWorkspace(outDir, buildResult.outputDigest, { from: outDir });
		return runTemplate({
			argv: [buildResult.outputPath],
			display: `run ${buildResult.outputPath}`,
		});
	},
	{ display: "run {0}", level: "info" },
);

/**
 * Lint an Odin package via `odin check -vet` (type-checks the package and
 * flags unused declarations/imports, variable shadowing, and `using`
 * statement misuse — no build output is produced). Mirrors cargoClippy /
 * ruffCheck: reports a structured `{ ok, output, fixSupported, fixApplied,
 * outputDigest }` instead of throwing, so `imp lint` can run every
 * selected target to completion and print a summary at the end.
 * `odin check` has no autofix mode, so `fix` is accepted (for a uniform
 * call signature across every lint handler) but always a no-op here.
 *
 * @param {object} handle Label handle returned by odinPackage().
 * @param {{fix?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, output: string, fixSupported: boolean, fixApplied: boolean, outputDigest: string|null}>}
 */
export const odinLint = memo(
	async function odinLint(handle, { fix = false } = {}) {
		handle = odin_package_handle(handle);
		const toolchainHandle = handle.attrs.toolchain;
		const odinToolSpec = toolchainHandle
			? await tool(toolchainHandle)
			: await odinTool(
					resolveOdinToolchainVersion(handle.attrs.toolchainVersion),
				);
		const srcs = await sources(handle);
		const genInputs = await collect_gen_sets(handle, new Set());
		const resourceInputs = await resources(handle);
		const flags = await collection_flags(handle);
		const collectionDirs = await collection_dirs(handle);
		const analysis = await odinPackageAnalysis(handle);
		if (analysis.sourceFiles.length === 0) {
			const packagePath = declared_path(handle, handle.attrs.path || ".");
			throw new Error(empty_package_error(handle, packagePath));
		}
		const path = analysis.packagePath;
		// Unlike odinBuild/odinTest, `odin check` never invokes a C
		// compiler/linker — it only type-checks — so this doesn't go through
		// odinScriptTools() (which always requires a declared default gcc
		// toolchain). Only `mkdir` is needed, to materialize collection dirs.
		const mkdirTool = await nativeToolSpec(nativeTool("mkdir"));
		const result = await run({
			argv: [
				"sh",
				"-c",
				'pkg=$1; dir_count=$2; shift 2; while [ "$dir_count" -gt 0 ]; do mkdir -p "$1"; shift; dir_count=$((dir_count - 1)); done; odin check "$pkg" -vet "$@"',
				"odin-check",
				path,
				String(collectionDirs.length),
				...collectionDirs,
				...flags,
			],
			tools: [odinToolSpec, mkdirTool],
			inputs: [srcs, ...genInputs, ...resourceInputs],
			allowFailure: true,
			display: `odin check -vet ${path}`,
		});
		let out = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (fix) {
			out = `note: --fix is not supported for odin check -vet; ran plain lint.\n${out}`;
		}
		return {
			ok: result.exitCode === 0,
			output: out,
			fixSupported: false,
			fixApplied: false,
			outputDigest: null,
		};
	},
	{ display: "lint {0}", level: "info" },
);

export const odinDistPackage = memo(
	async function odinDistPackage(handle) {
		handle = odin_package_handle(handle);
		const buildResult = await odinBuild(handle);
		const outDir = build_output_scope(buildResult.outputPath);
		return artifact(buildResult.outputDigest, { from: outDir });
	},
	{ display: "package {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// Odin source generation
// ---------------------------------------------------------------------------

export const gen_input_sources = memo(
	async function gen_input_sources(handle) {
		handle = odin_package_handle(handle);
		const outPath = declared_path(handle, handle.attrs.out);
		return glob({
			root: ".",
			include: handle.attrs.srcs || [],
			exclude: [outPath],
		});
	},
	{ display: "gen input sources {0}", level: "debug" },
);

export const odinGenRun = memo(
	async function odinGenRun(handle) {
		handle = odin_package_handle(handle);
		const inputFiles = await gen_input_sources(handle);
		const outPath = declared_path(handle, handle.attrs.out);

		if (handle.attrs.generator) {
			const mod = await import(handle.attrs.generator);
			const content = await mod.generate({ srcs: handle.attrs.srcs });
			// Content rides in argv so it keys the task cache; no shell
			// interpolation touches it (same pattern as vs.js writeJsonFile).
			return run({
				argv: [
					"sh",
					"-c",
					'printf %s "$2" > "$1"',
					"odin-gen-write",
					output_path(outPath),
					content,
				],
				outputs: [output(outPath)],
				materialize: true,
				display: `generate ${outPath}`,
			});
		}

		return run({
			argv: [...handle.attrs.cmd, outPath],
			inputs: [inputFiles],
			outputs: [output(outPath)],
			materialize: true,
			sandbox: false,
			impure: true,
			display: `generate ${outPath}`,
		});
	},
	{ display: "build {0}", level: "info" },
);

async function collect_gen_sets(handle, seen) {
	handle = odin_package_handle(handle);
	const key = dep_key(handle);
	if (seen.has(key)) return [];
	seen.add(key);

	const sets = [];
	for (const rawDep of handle.deps.map((dep) => dep.handle)) {
		if (!rawDep) continue;
		const dep = odin_package_handle(rawDep);
		if (dep.kind === "odin-gen") {
			await odinGenRun(dep);
			const addr = labelAddress(dep.label);
			const scope = addr.slice(2).split(":")[0];
			const outPath = scope
				? normalize_workspace_path(`${scope}/${dep.attrs.out}`)
				: normalize_workspace_path(dep.attrs.out);
			sets.push(file_set.literal([outPath]));
		}
	}
	for (const dep of await effective_deps(handle)) {
		sets.push(...(await collect_gen_sets(dep, seen)));
	}
	return sets;
}

/**
 * Declare an Odin source generation label.
 *
 * The generator command is run with the output path appended as the last argument.
 * Generated files must be excluded from any odinPackage glob that covers the same
 * directory — use the `exclude` option of odinPackage to enforce single ownership.
 *
 * @category target
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns for input files (for incremental tracking).
 * @param {string} opts.out Output file path, relative to the declaring BUILD.js directory.
 * @param {string[]} opts.cmd Command to run; output path is appended as the final argument.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Exported label handle.
 */
export const odinGen = extensible(function odinGen({
	srcs = [],
	out,
	cmd,
	generator,
	deps = [],
} = {}) {
	if (!out) throw new Error("odinGen requires an 'out' path");
	if (!generator && (!cmd || cmd.length === 0))
		throw new Error("odinGen requires either 'cmd' or 'generator'");

	const genLabel = label({
		data: {
			__odinKind: "gen",
			srcs,
			out,
			...(generator ? { generator } : { cmd }),
			deps: normalize_deps(deps),
		},
	});

	attachBuild(genLabel, async function buildOdinGen() {
		return odinGenRun(genLabel);
	});

	return genLabel;
});

// ---------------------------------------------------------------------------
// Exported label factories
// ---------------------------------------------------------------------------

/**
 * Declare an Odin package target.
 *
 * Sources are discovered lazily at build time via own_sources() / sources().
 *
 * @category target
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns matched against paths relative to opts.path.
 * @param {string[]} [opts.exclude=[]] Glob patterns to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]|object} [opts.collections=[]] Package-local Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {string} [opts.output] Workspace-relative executable output path.
 * @param {Array} [opts.deps=[]] Odin package and resource package dependencies.
 * @returns {object} Exported label handle.
 */
export const odinPackage = extensible(function odinPackage({
	srcs = undefined,
	exclude = undefined,
	path = ".",
	collections = [],
	toolchain,
	output,
	deps = [],
} = {}) {
	const toolchainHandle =
		toolchain && toolchain.__imp
			? toolchain
			: typeof toolchain === "string"
				? null
				: defaultOdinToolchain();
	const toolchainVersion = typeof toolchain === "string" ? toolchain : null;

	const normalizedDeps = normalize_deps(deps);

	// If sources are not specified, default to all .odin files in the package path.
	// Empty source lists are not useful for Odin package builds and produce invalid
	// glob filesets, so treat them like the omitted case.
	srcs = package_srcs({ srcs });

	if (exclude === undefined) {
		// exclude test files by default
		exclude = ["*_test.odin", "test_*.odin"];
	}

	const packageLabel = label({
		data: {
			__odinKind: "package",
			path,
			srcs,
			exclude,
			collections,
			deps: normalizedDeps,
			output,
			...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
			...(toolchainVersion ? { toolchainVersion } : {}),
		},
	});
	_odinPackageLabels.push(packageLabel);

	attachBuild(packageLabel, async function buildOdinPackage() {
		return odinBuild(packageLabel);
	});
	attachRun(packageLabel, async function runOdinPackage(ctx) {
		const template = await odinRun(packageLabel);
		return runFromTemplate(template, {
			args: ctx.args,
			sandbox: true,
			workspaceCwd: true,
			impure: true,
			stream: true,
		});
	});
	attachLint(packageLabel, async function lintOdinPackage(ctx) {
		return odinLint(packageLabel, { fix: !!ctx.flags.fix });
	});
	attachPackage(packageLabel, async function packageOdinPackage() {
		const artifactResult = await odinDistPackage(packageLabel);
		if (artifactResult === null) return null;
		const address = labelAddress(packageLabel);
		const withoutSlashes = address.replace(/^\/\//, "");
		const [dir, name] = withoutSlashes.split(":");
		const destination = dir ? `dist/${dir}/${name}` : `dist/${name}`;
		writeWorkspace(destination, artifactResult.digest, {
			from: artifactResult.from,
		});
		logInfo(`${address}#package -> ${destination}`);
		return artifactResult;
	});

	return packageLabel;
});

/**
 * Declare an Odin test package target.
 *
 * Test packages participate in the `test` goal and run `odin test`.
 * Unlike odinPackage, they include test files by default.
 *
 * @category target
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns matched against paths relative to opts.path.
 * @param {string[]} [opts.exclude=[]] Glob patterns to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]|object} [opts.collections=[]] Package-local Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {Array} [opts.deps=[]] Odin package and resource package dependencies.
 * @returns {object} Exported label handle.
 */
export const odinTestPackage = extensible(function odinTestPackage({
	srcs = undefined,
	exclude = undefined,
	path = ".",
	collections = [],
	toolchain,
	deps = [],
} = {}) {
	const toolchainHandle =
		toolchain && toolchain.__imp
			? toolchain
			: typeof toolchain === "string"
				? null
				: defaultOdinToolchain();
	const toolchainVersion = typeof toolchain === "string" ? toolchain : null;

	const normalizedDeps = normalize_deps(deps);

	srcs = package_srcs({ srcs });
	exclude = exclude || [];

	const packageLabel = label({
		data: {
			__odinKind: "testPackage",
			path,
			srcs,
			exclude,
			collections,
			deps: normalizedDeps,
			...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
			...(toolchainVersion ? { toolchainVersion } : {}),
		},
	});
	_odinTestPackageLabels.push(packageLabel);

	attachTest(packageLabel, async function testOdinTestPackage() {
		return odinTest(packageLabel);
	});

	return packageLabel;
});

export const odin_test_package = odinTestPackage;

// ---------------------------------------------------------------------------
// generate-build
// ---------------------------------------------------------------------------

export const generateBuild = memo(
	async function generateBuild() {
		const files = allUnowned({
			root: ".",
			include: ["**/*.odin"],
			exclude: DEFAULT_GENERATE_BUILD_EXCLUDES,
		});
		const normalDirs = new Set(
			files.filter(default_package_source_file).map(dirname),
		);
		const testDirs = new Set(
			files.filter(default_package_test_file).map(dirname),
		);
		const dirs = Array.from(normalDirs).sort();
		const existingPackages = _odinPackageLabels.map(package_spec_from_handle);
		const existingTestPackages = _odinTestPackageLabels.map(
			package_spec_from_handle,
		);
		const existingPaths = new Set(
			existingPackages.map((pkg) => normalize_workspace_path(pkg.path || ".")),
		);
		const existingTestPaths = new Set(
			existingTestPackages.map((pkg) =>
				normalize_workspace_path(pkg.path || "."),
			),
		);
		const generatedPackages = dirs
			.map(generated_package_spec)
			.filter(
				(pkg) => !existingPaths.has(normalize_workspace_path(pkg.path || ".")),
			);
		const index = build_package_index([
			...existingPackages,
			...generatedPackages,
		]);
		const collections = collection_map(null);
		const result = {};
		for (const pkg of generatedPackages) {
			const deps = infer_dep_entries(pkg, index, collections).map((dep) =>
				targetRef(dep.address),
			);
			const props = { srcs: ["*.odin"] };
			if (deps.length > 0) {
				props.deps = deps;
			}
			append_build_target(result, build_file_for_dir(pkg.path), {
				name: target_name_for_dir(pkg.path),
				rule: "odinPackage",
				props,
			});
		}

		const generatedTestPackages = Array.from(testDirs)
			.sort()
			.map((dir) => ({
				...generated_package_spec(dir),
				srcs: ["*.odin"],
				exclude: [],
			}))
			.filter(
				(pkg) =>
					!existingTestPaths.has(normalize_workspace_path(pkg.path || ".")),
			);
		for (const pkg of generatedTestPackages) {
			const deps = infer_dep_entries(pkg, index, collections).map((dep) =>
				targetRef(dep.address),
			);
			const props = {};
			if (deps.length > 0) {
				props.deps = deps;
			}
			const baseName = target_name_for_dir(pkg.path);
			append_build_target(result, build_file_for_dir(pkg.path), {
				name: normalDirs.has(pkg.path) ? `${baseName}_test` : baseName,
				rule: "odinTestPackage",
				props,
			});
		}
		return result;
	},
	{ display: "generate Odin BUILD files", level: "info" },
);

registerBuildGenerator({ namespace: "odin", generate: generateBuild });
