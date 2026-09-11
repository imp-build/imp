import { BUILD } from "//rules/workflows/build";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import {
	field,
	defineConfigSchema,
	allUnowned,
	glob,
	paths,
	read_file,
	memo,
	output,
	files,
	task,
	expand,
	packagePath,
	semantic,
	registerBuildRule,
	configuration,
	labelAddress,
	targetAddress,
	targetRef,
	platformInfo,
} from "imp:core";
import { odinGrammarFixture, odinAnalyzer } from "//rules/treesitter";
// Side-effect import: registers the shared `opt` (debug/release) mode axis
// so `--axis opt=...`/`--profile ...` works for Odin targets even in a
// workspace that doesn't import //rules/imp/mode itself.
import "//rules/imp/mode";

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
	defaultOdinToolchainVersion,
	odinGraphTool,
	odinLinkerFor,
	odinUsesLldOnWindows,
	odinUsesMingwCrt,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

import {
	assertGeneratedSrcPath,
	dedupeGeneratedSrcs,
	normalizeGeneratedSrcs,
} from "//rules/imp/codegen";

import {
	gccGraphTool,
	defaultGccToolchainVersion,
	gccWindowsRuntimeArchives,
} from "//rules/c/gcc";
import { moldOdinLinkerEnv } from "//rules/c/mold";
import { shellQuote } from "//rules/c/toolchain";
import { nativeTool } from "//rules/imp/native-tool";
import { ODIN_TOOL } from "//rules/odin/toolchain";

export {
	defaultOdinToolchain,
	defaultOdinToolchainVersion,
	odinArtifactName,
	odinBin,
	odinCacheKey,
	odinDownloadUrl,
	odinGenLockfiles,
	odinToolchain,
	odinTool,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

// How much of the `--jobs` budget one Odin compile/test action costs. Odin
// parallelises its own checker and backend, and `odin test` parallelises the
// test run on top of that, so an undeclared action would fan out to every core
// on the machine while the scheduler counted it as one. The same number is
// passed to the tool as -thread-count / -define:ODIN_TEST_THREADS (see
// odinCompileTask's argv) so the grant and the tool's own parallelism agree.
const ODIN_CORES = 4;

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

// Returns the workspace address for either a label() handle or a real
// Target handle (e.g. odinToolchain()) — or null when the handle is
// anonymous/unaddressed. Mirrors rules/rust/index.js's cargoPackageAddress.
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

function decode_odin_import_string(text) {
	if (text.length < 2) return null;
	const quote = text[0];
	if ((quote !== '"' && quote !== "`") || text[text.length - 1] !== quote)
		return null;
	if (quote === "`") return text.slice(1, -1);
	try {
		return JSON.parse(text);
	} catch (_) {
		return null;
	}
}

function odin_source_analysis_task() {
	const sources = files({
		root: ".",
		include: ["**/*.odin"],
		exclude: ["build/**"],
	});
	return task({
		display: "tree-sitter analyze Odin sources",
		inputs: {
			sources,
			grammar: odinGrammarFixture.archive,
			analyzer: odinAnalyzer[BUILD]["imp-treesitter-parse"],
		},
		outputs: { index: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.path(input.analyzer),
					exec.path(input.grammar),
					...exec.paths(input.sources),
				],
				inputs: [input.analyzer, input.grammar, input.sources],
			});
			return { index: JSON.parse(result.stdout) };
		},
	});
}

const odinSourceAnalysis = odin_source_analysis_task();

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

// Stable, path-safe slug derived from a package's own address — same role as
// the old Target-only targetOutputSlug(). Mirrors rules/rust/index.js's
// cargoPackageOutputSlug.
function addressSlug(address) {
	return address.replace(/^\/\//, "").replace(/[:/]/g, "_");
}

/** Default build output path for a graph-native package, given its resolved address. */
export function graphDefaultOutputPath(address) {
	return `build/odin/${addressSlug(address)}`;
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

function empty_package_error(handle, path, { test = false } = {}) {
	const address = safe_address(handle) || "odinPackage";
	const reason = test
		? "odinTestPackage globs *_test.odin and test_*.odin by default, and takes the rest of the package from its deps; pass srcs for a directory whose tests use another name."
		: "odinPackage excludes *_test.odin and test_*.odin by default; use odinTestPackage for package tests, or pass exclude: [] for a package that intentionally builds test files.";
	return (
		`${address} has no Odin source files after applying srcs/exclude filters at '${path}'. ` +
		reason
	);
}

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
		// Existing packages are graph-native odinPackage()/odinTestPackage()
		// declarations (graphPackages, below) — they only exist to dedup
		// directories that already have a package (so this generator doesn't
		// suggest a duplicate), not to feed cross-package dependency inference:
		// unlike the legacy label() path, a graph package spec has no resolved
		// workspace address available at declaration time to put in a
		// generated deps: [targetRef(...)] entry, so the dependency index below
		// only covers packages generated in this same pass.
		const existingPaths = new Set(
			graphPackages
				.filter((pkg) => !pkg.test)
				.map((pkg) => normalize_workspace_path(pkg.path || ".")),
		);
		const existingTestPaths = new Set(
			graphPackages
				.filter((pkg) => pkg.test)
				.map((pkg) => normalize_workspace_path(pkg.path || ".")),
		);
		const generatedPackages = dirs
			.map(generated_package_spec)
			.filter(
				(pkg) => !existingPaths.has(normalize_workspace_path(pkg.path || ".")),
			);
		const index = build_package_index(generatedPackages);
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

// ---------------------------------------------------------------------------
// Exported handle graphs
// ---------------------------------------------------------------------------

// Graph declarations deliberately keep only source/configuration data. Their
// action nodes are created by an expansion after every BUILD module has loaded,
// which lets import inference see packages declared later in the workspace.
const graphPackages = [];
const graphPackageHooks = [];
let graphPackageCounter = 0;

/** Register an optional facet enabled by importing an Odin extension. */
export function registerOdinPackageHook(hook) {
	if (typeof hook !== "function") {
		throw new Error("registerOdinPackageHook(hook) expects a function");
	}
	if (!graphPackageHooks.includes(hook)) graphPackageHooks.push(hook);
}

function graphPath(base, path = ".") {
	return normalize_workspace_path(
		base === "." ? path : path === "." ? base : `${base}/${path}`,
	);
}

function graphCollectionMap(spec, config) {
	const values = new Map(Object.entries(config?.collections || {}));
	if (Array.isArray(spec.collections)) {
		for (const entry of spec.collections) {
			if (
				entry &&
				typeof entry.name === "string" &&
				typeof entry.path === "string"
			) {
				values.set(entry.name, graphPath(spec.base, entry.path));
			}
		}
	} else if (spec.collections && typeof spec.collections === "object") {
		for (const [name, path] of Object.entries(spec.collections)) {
			values.set(name, graphPath(spec.base, path));
		}
	}
	return values;
}

function graphPackageSpec(spec) {
	return {
		address: `graph:${spec.key}`,
		path: spec.path,
		srcs: spec.srcs,
		exclude: spec.exclude,
	};
}

function graphAnalysis(spec, index, sourceFiles) {
	const filesByPath = index?.files || {};
	const imports = new Set();
	let hasMainEntrypoint = false;
	for (const path of sourceFiles) {
		const file = filesByPath[path];
		if (!file) continue;
		for (const imp of file.imports) imports.add(imp);
		hasMainEntrypoint = hasMainEntrypoint || file.hasMainEntrypoint;
	}
	const packagePath = infer_package_path(graphPackageSpec(spec), sourceFiles);
	const collections = Array.from(
		new Set(
			Array.from(imports)
				.map((imp) => {
					const index = imp.indexOf(":");
					return index > 0 ? imp.slice(0, index) : null;
				})
				.filter(Boolean),
		),
	).sort();
	return new OdinPackageAnalysis({
		sourceFiles,
		packagePath,
		imports: Array.from(imports).sort(),
		collections,
		hasMainEntrypoint,
	});
}

// Default exclusions for an ordinary (non-test) Odin package, whether it was
// declared by createGraphPackage() or reached as an undeclared directory.
const DEFAULT_PACKAGE_EXCLUDE = ["*_test.odin", "test_*.odin"];

// The mirror image, for an odinTestPackage(): exactly the files an ordinary
// package leaves out. Odin compiles a directory as one package, so a test
// package declares its test files and takes the rest from a dep on the
// package under test — one glob for the ordinary sources, in one place. A
// directory that holds only tests names its own srcs instead.
const DEFAULT_TEST_PACKAGE_SRCS = ["*_test.odin", "test_*.odin"];

function graphDeclaredPackageIndex() {
	const index = new Map();
	for (const candidate of graphPackages) {
		const path = normalize_workspace_path(candidate.path || ".");
		const current = index.get(path);
		// A test package and an ordinary package may share a directory. An
		// import names the directory's ordinary package, so prefer that one.
		if (current === undefined || (current.test && !candidate.test))
			index.set(path, candidate);
	}
	return index;
}

function graphResolveImport(imp, fromPath, collections) {
	if (!imp.includes(":")) {
		return { path: workspace_join(fromPath, imp), collection: null };
	}
	const resolved = resolved_import_path(imp, collections);
	if (resolved === null) return null;
	return { path: resolved, collection: imp.slice(0, imp.indexOf(":")) };
}

// One `odin build` compiles the root package together with everything it
// imports, so the sandbox needs the sources of the whole transitive import
// closure — not just the root package's own direct imports. Two kinds of
// directory reach that closure:
//
//   * a declared odinPackage(), contributing its own files() handle, and
//   * a directory reached through a collection mapping or a relative import
//     that no odinPackage() declares — typically a vendored library tree.
//     Those get a synthesized files() handle, which is what makes the
//     `-collection:name=path` flag point at a directory that exists inside
//     the sandbox at all (#88).
//
// Imports that don't resolve to a workspace path (`core:`, `vendor:`, and any
// other unmapped collection) belong to the toolchain and are left alone. An
// import that *does* resolve but has no package behind it is a declaration
// error, reported here where the importing package and the resolved path are
// both still known.
//
// Known limitation (#96): a package's generatedSrcs are staged for every
// package that reaches it (see graphGeneratedSrcs() below), but they are never
// import-scanned. analysis_for_package() reads real
// files via read_file()/glob() at BUILD-evaluation time, before any
// exec.action() — and thus a generated source's own producing action — has
// run. Any import a generated file needs must be satisfied by the consuming
// package's own deps/collections, same as any other source.
function graphSourceClosure(spec, analysis, config, analysisIndex) {
	const collections = graphCollectionMap(spec, config);
	const declared = graphDeclaredPackageIndex();
	const handles = [];
	const packages = [];
	const usedCollections = new Set();
	// Two visited sets, because a declared package and a directory are not the
	// same kind of thing. Paths stop an undeclared directory from being
	// globbed one time for each import that reaches it. Keys stop a declared
	// package from being walked two times.
	//
	// They have to be separate: an odinTestPackage() shares its directory with
	// the package it tests, and Odin compiles that directory as one package.
	// A test package globbing only `*_test.odin` therefore *needs* the
	// same-path package's own sources — merged into the same sandbox
	// directory, which is exactly what makes `odin test .` see both halves.
	// Keying only by path made that dep a no-op (the root's own path is
	// visited from the start), so a same-directory test package had to re-glob
	// every source itself and keep that glob in sync by hand.
	const visited = new Set([
		normalize_workspace_path(spec.path || "."),
		normalize_workspace_path(analysis.packagePath),
	]);
	const visitedKeys = new Set([spec.key]);
	const queue = [{ analysis, owner: spec.path }];

	const enqueueDeclared = (candidate) => {
		if (visitedKeys.has(candidate.key)) return;
		visitedKeys.add(candidate.key);
		const candidateAnalysis = graphAnalysis(
			candidate,
			analysisIndex,
			paths(
				glob({
					root: candidate.path,
					include: candidate.srcs,
					exclude: candidate.exclude,
				}),
			),
		);
		visited.add(normalize_workspace_path(candidate.path || "."));
		visited.add(normalize_workspace_path(candidateAnalysis.packagePath));
		handles.push(candidate.sources);
		packages.push(candidate);
		queue.push({ analysis: candidateAnalysis, owner: candidate.path });
	};

	for (const dep of spec.deps) {
		if (dep?.__odin_graph_package !== true) continue;
		const candidate = graphPackages.find((entry) => entry.key === dep.key);
		if (candidate) enqueueDeclared(candidate);
	}

	while (queue.length > 0) {
		const entry = queue.shift();
		for (const imp of entry.analysis.imports) {
			const resolved = graphResolveImport(
				imp,
				entry.analysis.packagePath,
				collections,
			);
			if (resolved === null) continue;
			if (resolved.collection !== null)
				usedCollections.add(resolved.collection);

			const path = normalize_workspace_path(resolved.path);
			const candidate = declared.get(path);
			if (candidate !== undefined) {
				enqueueDeclared(candidate);
				continue;
			}
			if (visited.has(path)) continue;
			visited.add(path);

			const vendoredSpec = {
				address: `//${path}`,
				path,
				srcs: ["*.odin"],
				exclude: DEFAULT_PACKAGE_EXCLUDE,
			};
			const vendoredFiles = Object.keys(analysisIndex.files || {})
				.filter((file) => file.startsWith(`${path}/`))
				.filter((file) => file.slice(path.length + 1).indexOf("/") < 0)
				.filter(
					(file) =>
						!file.endsWith("_test.odin") &&
						!file.split("/").pop().startsWith("test_"),
				);
			const vendored = graphAnalysis(
				vendoredSpec,
				analysisIndex,
				vendoredFiles,
			);
			if (vendored === null || vendored.sourceFiles.length === 0) {
				throw new Error(
					`Odin package '${entry.owner}' imports '${imp}', which resolves to '${path}', ` +
						"but there is no Odin package there. " +
						(resolved.collection === null
							? "Check the import path."
							: `Check the '${resolved.collection}' collection mapping.`),
				);
			}
			handles.push(
				files({
					root: path,
					include: ["*.odin"],
					exclude: DEFAULT_PACKAGE_EXCLUDE,
				}),
			);
			queue.push({ analysis: vendored, owner: path });
		}
	}

	return {
		handles,
		// Every declared package the closure reached, in visit order, root
		// excluded — the packages whose own sources this one compilation
		// compiles. graphResourceInputs() below reads their deps.
		packages,
		// Only the collections the closure actually reached: a flag for an
		// unused collection names a directory we have no reason to declare as
		// an input, which is the shape of #88 all over again.
		collections: [...collections.entries()].filter(([name]) =>
			usedCollections.has(name),
		),
	};
}

// The native inputs one `odin build` needs, collected over every declared
// package the source closure reached — not over the root package's own deps
// alone.
//
// A `foreign import` is a property of the source that declares it, and one
// `odin build` compiles the whole import closure. So an archive a dep package
// needs is an archive *this* compilation needs, whether the dep was reached
// through `deps` or through a bare `import`. Collecting only the root's deps
// made every consumer repeat the dep package's own native declarations, and a
// consumer that forgot got no error until the linker failed to find the
// archive file.
//
// `unsafeSystemPaths` deliberately does not travel this path. It is a
// guard-bypass flag, and rules/c keeps it out of the transitive contract as
// well (see ccLibrary()/cmakeLibraryDep()) — every target declares its own.
function graphResourceInputs(specs) {
	const resources = [];
	const linkoptLists = [];
	// The shared libraries, kept as their own list as well as being staged
	// with the other resources. The link step treats them the same as an
	// archive, but graphOdinBundle() below has to know which resources are
	// files that must also travel beside the executable at run time.
	const sharedLibs = [];
	// A package is commonly reachable both directly and through a dep, so the
	// same archive arrives more than one time. Dedup keeps the action inputs
	// (and thus the task key) minimal.
	const seenResources = new Set();
	const pushResource = (handle) => {
		const key = handle?.__graph_id ?? handle;
		if (seenResources.has(key)) return;
		seenResources.add(key);
		resources.push(handle);
	};
	for (const spec of specs) {
		for (const dep of spec.deps) {
			// Odin package deps travel the source closure above; anything else
			// contributes its sources/resources as opaque extra inputs.
			if (dep?.__odin_graph_package === true) continue;
			// A bare graph handle — files(), or a task output — is a resource
			// in its own right. It used to need a { sources: ... } wrapper, and
			// a handle passed directly was dropped without a word.
			if (dep?.__imp_graph_handle === true) {
				pushResource(dep);
				continue;
			}
			let recognized = false;
			if (dep?.sources?.__imp_graph_handle === true) {
				pushResource(dep.sources);
				recognized = true;
			}
			if (dep?.resources?.__imp_graph_handle === true) {
				pushResource(dep.resources);
				recognized = true;
			}
			// ccLibrary()/cmakeLibraryDep()-shaped deps (issue #100): their
			// transitiveArchives land in the sandbox at their real captured path
			// (e.g. build/c/<slug>.a), which is exactly what a `foreign import`
			// referencing that path needs — no linker flag involved, Odin
			// resolves foreign imports as literal sandbox-relative paths.
			if (Array.isArray(dep?.transitiveArchives)) {
				for (const archive of dep.transitiveArchives) pushResource(archive);
				recognized = true;
			}
			// A dep's shared libraries need mounting for the same reason its
			// archives do — they are files a `foreign import` names by path.
			// They travel their own bucket because rules/c must keep them off
			// its own `ar` step (see rules/c/index.js's own docstring); to Odin
			// the two are alike, so both get staged.
			if (Array.isArray(dep?.transitiveSharedLibs)) {
				for (const sharedLib of dep.transitiveSharedLibs) {
					if (!seenResources.has(sharedLib?.__graph_id ?? sharedLib)) {
						sharedLibs.push(sharedLib);
					}
					pushResource(sharedLib);
				}
				recognized = true;
			}
			// A dep's own transitiveLinkopts (e.g. a cmakeLibraryDep()'s
			// pkg-config-derived -L/-l flags for a shared library's own
			// dependencies) — unlike transitiveArchives, these aren't files Odin
			// can resolve as `foreign import` paths, so they instead need to
			// reach the final `odin build`'s own linker invocation directly (see
			// graphOdinBuild()'s -extra-linker-flags: handling below).
			if (Array.isArray(dep?.transitiveLinkopts)) {
				linkoptLists.push(dep.transitiveLinkopts);
				recognized = true;
			}
			// A dep of no recognized shape contributed nothing at all, which is
			// indistinguishable from not declaring it — the failure then
			// surfaces as a missing file at compile or link time, far from the
			// declaration that was meant to supply it.
			if (!recognized) {
				throw new Error(
					`Odin package '${spec.path}' has a dep of an unrecognized shape, which would contribute nothing. ` +
						"deps accepts an odinPackage()/odinTestPackage(), a ccLibrary()/cmakeLibraryDep(), " +
						"a graph handle such as files(), or an object with a `sources` or `resources` handle.",
				);
			}
		}
	}
	return { resources, sharedLibs, linkopts: odinMergeLinkopts(linkoptLists) };
}

// The generated sources one `odin build` needs, over the whole source
// closure — same reasoning as graphResourceInputs() above. A generated file is
// an ordinary source of the package that declares it, and one `odin build`
// compiles that package's directory along with everything else in the closure,
// so the file has to be staged whether the compilation was reached through the
// declaring package or through a consumer of it.
//
// Keyed by the real workspace path each artifact lands at, because that path
// is the whole contract (see graphOdinBuild()'s own check of it): two packages
// naming one artifact at one path are one input, and two *different* artifacts
// claiming the same path would silently overwrite each other in the sandbox.
function graphGeneratedSrcs(specs) {
	return dedupeGeneratedSrcs(
		specs.flatMap((spec) => spec.generatedSrcs || []),
		{ rule: "odinPackage" },
	);
}

function graphPackageExpansion(spec) {
	if (spec.expansion) return spec.expansion;
	spec.expansion = expand({
		display: `expand Odin package ${spec.path}`,
		inputs: {
			sources: spec.sources,
			analysis: odinSourceAnalysis.outputs.index,
			config: semantic.config("odin"),
		},
		async create(inputs) {
			const analysis = graphAnalysis(
				spec,
				inputs.analysis,
				paths(inputs.sources.fileset),
			);
			return {
				[spec.key]: graphActions(
					spec,
					analysis,
					inputs.config || {},
					inputs.analysis,
				),
			};
		},
	});
	return spec.expansion;
}

// odinToolchain(version, { linker }) records the linker against the
// *declared* version; a package's spec.version is only set when its own
// toolchain option was a bare version string (createGraphPackage() above) —
// omitted or a graph handle passed directly both leave it undefined, in
// which case the workspace default toolchain's linker (if any) applies.
// This mirrors spec.version's own existing fallback semantics elsewhere in
// this file; a package pinned to an explicit non-default toolchain *handle*
// (rather than a version string) is the one case this can't distinguish,
// same pre-existing gap spec.version already has.
function odinLinkerHandleFor(spec) {
	return odinLinkerFor(spec.version || defaultOdinToolchainVersion());
}

// Same spec.version fallback as odinLinkerHandleFor() above, for
// odinToolchain(version, { mingwCrt }) instead of { linker }.
function odinUsesMingwCrtFor(spec) {
	return odinUsesMingwCrt(spec.version || defaultOdinToolchainVersion());
}

// Same spec.version fallback as odinLinkerHandleFor() above, for
// odinToolchain(version, { lldOnWindows }) instead of { linker }.
function odinUsesLldOnWindowsFor(spec) {
	return odinUsesLldOnWindows(spec.version || defaultOdinToolchainVersion());
}

function graphActionInputs(
	spec,
	analysis,
	config,
	analysisIndex,
	{ lint = false } = {},
) {
	const closure = graphSourceClosure(spec, analysis, config, analysisIndex);
	const { resources, sharedLibs, linkopts } = graphResourceInputs([
		spec,
		...closure.packages,
	]);
	const linker = odinLinkerHandleFor(spec);
	const inputs = {
		sources: spec.sources,
		odin: spec.toolchain,
		gcc: gccGraphTool(defaultGccToolchainVersion(), {
			unsafeSystemPaths: spec.unsafeSystemPaths,
		}),
		...(linker ? { moldTool: linker.tool } : {}),
		analysis: {
			packagePath: analysis.packagePath,
			hasMainEntrypoint: analysis.hasMainEntrypoint,
			collections: closure.collections,
			linkopts,
		},
		// A declared handle, not a construction-time configuration() read.
		// The value still reaches the action through odinModeFlags() in
		// argv, which is what makes the cache key change with the axis. What
		// the declared input adds is visibility: the graph can now see that
		// this task reads the `opt` axis, thus an edge is able to build it
		// under a different configuration while every task that reads no
		// axis stays shared. `null` (no axis resolved, e.g. this rule's own
		// JS unit tests) reads as "debug", the declared default of the axis
		// in //rules/imp/mode.
		//
		// `odin check -vet` is a type check with no codegen, thus it reads
		// no mode flags (see run() below). It must not declare the axis
		// either: a declared input that the action does not use would make
		// lint build one time for each configuration for the same result.
		...(lint ? {} : { opt: semantic.mode("opt") }),
	};
	for (const [index, source] of closure.handles.entries()) {
		inputs[`source${index}`] = source;
	}
	for (const [index, resource] of resources.entries()) {
		inputs[`resource${index}`] = resource;
	}
	const generatedSrcs = graphGeneratedSrcs([spec, ...closure.packages]);
	for (const [index, generated] of generatedSrcs.entries()) {
		inputs[`generated${index}`] = generated.artifact;
	}
	inputs.generatedExpectedPaths = generatedSrcs.map((g) => g.expectedPath);
	// Which of the staged resources are shared libraries, by their own
	// `resource<N>` key. `odin test` runs the binary it builds inside its own
	// action, so it is the one case that has to find those libraries at run
	// time from inside the sandbox — see odinTestLibraryPathEnv() below.
	inputs.sharedLibResourceIndices = resources.flatMap((resource, index) =>
		sharedLibs.includes(resource) ? [index] : [],
	);
	return inputs;
}

/**
 * The `odin build`/`odin test` flags for the shared `opt` mode axis (see
 * //rules/imp/mode): `-debug` for debug info + runtime bounds/type checks,
 * `-o:speed` to optimize for speed instead. Any value other than "release"
 * is treated as "debug", matching the axis's own declared default.
 *
 * @param {string} opt Resolved "opt" mode axis value.
 * @returns {string[]}
 */
export function odinModeFlags(opt) {
	return opt === "release" ? ["-o:speed"] : ["-debug"];
}

/**
 * Merge the transitiveLinkopts of every dep the source closure reached into
 * one flag list. One library is commonly reachable more than one time (both
 * directly and through a dep package), so a flag is kept at its first
 * occurrence only — that keeps the linker's own left-to-right order, which
 * decides how it resolves symbols.
 *
 * @param {string[][]} lists One `transitiveLinkopts` array per dep, in closure
 *   order.
 * @returns {string[]}
 */
export function odinMergeLinkopts(lists) {
	const seen = new Set();
	const merged = [];
	for (const opt of lists.flat()) {
		if (seen.has(opt)) continue;
		seen.add(opt);
		merged.push(opt);
	}
	return merged;
}

/**
 * A dep's own transitiveLinkopts (e.g. a cmakeLibraryDep()'s pkg-config-
 * derived -L/-l flags) reach Odin's own linker invocation as a single
 * `-extra-linker-flags:"..."` arg — Odin takes one string, not repeated
 * flags, so this joins them the same way gccCMakeCompilerArgs()'s own
 * compiler-args construction already does for CMake.
 *
 * @param {string[]} linkopts
 * @returns {string[]} `[]`, or a single `-extra-linker-flags:` arg.
 */
export function odinExtraLinkerFlagsArgs(linkopts) {
	return linkopts.length > 0
		? [`-extra-linker-flags:${linkopts.join(" ")}`]
		: [];
}

/**
 * The gcc toolchain bin dir to put on PATH for Odin's own linker invocation
 * (Odin execs a program literally named "clang" to link — see gccTool()'s
 * own docstring). Its graph tool selects either bin/ or bin-unsafe-paths/
 * before the executor constructs PATH, so the mounted tool's own normal bin/
 * directory cannot override an unsafeSystemPaths selection.
 *
 * @param {string} clangPath Sandbox path to the GCC tool's `clang` launcher
 *   (`exec.tool(resolved.gcc, "clang")`).
 * @returns {string}
 */
export function odinLinkerPathDir(clangPath) {
	const executable = `clang${platformInfo().os === "windows" ? ".exe" : ""}`;
	const suffix = `/${executable}`;
	if (!clangPath.endsWith(suffix)) {
		throw new Error(
			`expected GCC clang launcher path ending in '${suffix}', got '${clangPath}'`,
		);
	}
	return clangPath.slice(0, -suffix.length);
}

/**
 * Resolve the GCC linker directory through the graph tool mount. `exec.path`
 * is not valid here: a mounted graph tool is available only at its
 * `.imp/tools/...` mount point.
 *
 * @param {object} exec Task executor.
 * @param {object} resolvedGccTool Resolved GCC graph tool input.
 * @returns {string}
 */
export function odinGccLinkerPathDir(exec, resolvedGccTool) {
	return odinLinkerPathDir(exec.tool(resolvedGccTool, "clang"));
}

/**
 * The `LD_LIBRARY_PATH` entry an `odin test` action needs, or no entry at all.
 *
 * `odin test` compiles *and runs* in one action, so unlike `odin build` it has
 * no product for graphOdinBundle() to carry a shared library in. Odin's own
 * `$ORIGIN` rpath does not help either: it resolves to wherever odin put the
 * test binary (the sandbox root), not to the `build/c/` directory the library
 * is staged under. Measured as a real failure before this: "error while
 * loading shared libraries: librules_odin_example_shared.so".
 *
 * The entries are relative paths, which the loader reads against the working
 * directory. That is sound here because a build action's cwd *is* the sandbox
 * root, which is the same root the staged paths are relative to.
 *
 * Unlike the executor-wide loader path this replaces, this is a declared env
 * value on one action: it keys that action's own digest, and it names a staged
 * directory, never a host one.
 *
 * Left out on Windows, which has no `LD_LIBRARY_PATH` — the epic that covers
 * shared-library run-time linkage scopes Windows out, because it finds a DLL
 * beside the executable through its own default search order.
 *
 * @param {string[]} sharedLibPaths Sandbox paths of the staged shared libraries.
 * @returns {string[]} `[]`, or a single `LD_LIBRARY_PATH=` env entry.
 */
export function odinTestLibraryPathEnv(sharedLibPaths) {
	if (platformInfo().os === "windows") return [];
	const directories = [];
	for (const libraryPath of sharedLibPaths) {
		const slash = String(libraryPath).lastIndexOf("/");
		const directory = slash === -1 ? "." : libraryPath.slice(0, slash);
		if (!directories.includes(directory)) directories.push(directory);
	}
	return directories.length > 0
		? [`LD_LIBRARY_PATH=${directories.join(":")}`]
		: [];
}

// The filename `odin build -out:` writes an executable to. Odin's Windows
// linker rejects an output path with no extension ("must have an appropriate
// extension") — confirmed by a real `odin build` failure. Shared with
// graphOdinBundle(), which copies that file into the product directory under
// the same name.
function odinExeName() {
	return `output${platformInfo().os === "windows" ? ".exe" : ""}`;
}

function graphOdinBuild(
	spec,
	analysis,
	config,
	analysisIndex,
	{ test = false, lint = false } = {},
) {
	const inputs = graphActionInputs(spec, analysis, config, analysisIndex, {
		lint,
	});
	// `odin test` compiles and runs in one step and names its binary after the
	// package, so there is no artifact to declare and no -out: to pass (below):
	// its exit code is the whole result, the same shape python's testRoot() and
	// rust's per-crate test-run action already use. `odin check -vet` likewise
	// writes nothing.
	const captures = !lint && !test;
	// The library case needs no platform-correct extension the way
	// odinExeName() does: Odin accepts a plain ".a" for -build-mode:lib output
	// on Windows too.
	const outputPath = !captures
		? null
		: analysis.hasMainEntrypoint
			? odinExeName()
			: "output.a";
	return task({
		display: `${lint ? "odin check -vet" : test ? "odin test" : "odin build"} ${analysis.packagePath}`,
		inputs,
		outputs: lint
			? { result: output.value() }
			: test
				? { units: output.value() }
				: { artifact: output.artifact(), executablePath: output.value() },
		async run(exec, resolved) {
			const flags = resolved.analysis.collections.map(
				([name, path]) => `-collection:${name}=${path}`,
			);
			// `odin check` is a pure type-check with no codegen, so
			// optimization/debug-info flags don't apply to it — only
			// build/test actually compile.
			const modeFlags = lint ? [] : odinModeFlags(resolved.opt || "debug");
			const allInputs = Object.entries(resolved)
				.filter(
					([name]) =>
						name === "sources" ||
						name.startsWith("source") ||
						name.startsWith("resource") ||
						/^generated\d+$/.test(name),
				)
				.map(([, value]) => value);
			// Generated sources aren't scanned for imports (they don't exist
			// on disk until their producing exec.action() runs, well after
			// BUILD-evaluation-time analysis_for_package() would need to read
			// them) — a generated file's own imports must be satisfied via
			// this package's deps/collections like any other source. What is
			// checked here is the one contract generatedSrcs relies on: the
			// artifact must land exactly at the workspace path the entry
			// declares — spec.path + a relative path, or a codegen() output
			// path — since `odin build spec.path` only discovers files that
			// are actually inside that directory.
			for (const [index, expected] of (
				resolved.generatedExpectedPaths || []
			).entries()) {
				assertGeneratedSrcPath(
					"odinPackage",
					index,
					exec.path(resolved[`generated${index}`]),
					expected,
				);
			}
			const command = lint ? "check" : test ? "test" : "build";
			// `odin check` never links (it's a pure type-check, no -out: even)
			// and rejects -linker:/-extra-linker-flags: outright — only
			// `build`/`test` actually invoke the linker.
			const linker = odinLinkerHandleFor(spec);
			const linkerEnv =
				linker && !lint
					? moldOdinLinkerEnv(exec, resolved.moldTool, linker.version)
					: null;
			// Odin's default Windows linker is MSVC's link.exe, which does its
			// own Visual Studio/Windows SDK auto-detection and needs no LIB/
			// INCLUDE plumbing from this workspace, but cannot read GCC/mingw-
			// produced C++ object files reliably — confirmed by a real failure
			// linking a mingw-built BoringSSL: "fatal error LNK1143: invalid or
			// corrupt file: no symbol for COMDAT section". lld-link handles both
			// MSVC- and GCC-style COFF objects, and ships bundled at
			// <odin-root>/bin/lld-link.exe (found by Odin automatically — no
			// separate toolchain/PATH plumbing needed, the way mold's Linux-only
			// linker handle above requires) — but unlike system link.exe it does
			// *not* auto-detect the MSVC/Windows SDK library search path, so
			// linking anything that actually needs the CRT (memset,
			// mainCRTStartup, ...) fails outright unless this workspace also
			// supplies LIB itself (e.g. via //rules/c/msvc's msvcEnv()) —
			// confirmed by a real `odin build` failure: "lld-link: error:
			// undefined symbol: memset" with no LIB plumbed. So lld-link is
			// opt-in via odinToolchain(version, { lldOnWindows: true }), same as
			// { mingwCrt } below — not used just because a package hasn't picked
			// an explicit linker via odinToolchain(version, { linker }).
			const useLldOnWindows =
				!lint &&
				!linker &&
				platformInfo().os === "windows" &&
				odinUsesLldOnWindowsFor(spec);
			// odinToolchain(version, { mingwCrt: true }) opts a workspace into
			// the mingw-CRT substitution below — its Windows C/C++ deps are
			// built with the gcc/mingw toolchain (//rules/c/gcc's default), so
			// their object code needs mingw's own CRT/UCRT symbols rather than
			// MSVC's. By default (mingwCrt unset) Odin's own MSVC CRT linking
			// is left in place — lld-link still gets used regardless (it reads
			// both MSVC- and GCC-style COFF objects, per useLldOnWindows's own
			// comment above), only the CRT choice changes.
			const useMingwCrt = useLldOnWindows && odinUsesMingwCrtFor(spec);
			// `odin test` already tolerates a package with no `main` (that's the
			// whole point of the test build mode); `build` and `check` both
			// default to expecting one. `build` already opts out via
			// -build-mode:lib (a flag `check` doesn't support); `check` has its
			// own -no-entry-point for the same purpose — without it, a
			// library-only or test-only package declared directly as a target
			// (not merely imported as a dep) fails `imp lint` with "Undefined
			// entry point procedure 'main'", as #100's fixture does.
			const args = [
				exec.tool(resolved.odin, "odin"),
				command,
				resolved.analysis.packagePath,
				// Both of these must stay in step with the `cores:` the action
				// declares below, or the compiler and its test runner each fan
				// out to every core on the machine while the scheduler thinks
				// this action costs ODIN_CORES of them. -thread-count caps the
				// compiler itself (accepted by build, test and check alike);
				// ODIN_TEST_THREADS caps core:testing's runner, which otherwise
				// defaults to os.get_processor_core_count() (see runner.odin's
				// `when TEST_THREADS == 0` branch).
				`-thread-count:${ODIN_CORES}`,
				...(test ? [`-define:ODIN_TEST_THREADS=${ODIN_CORES}`] : []),
				...flags,
				...modeFlags,
				...(lint ? ["-vet"] : []),
				...(!resolved.analysis.hasMainEntrypoint
					? lint
						? ["-no-entry-point"]
						: !test
							? ["-build-mode:lib"]
							: []
					: []),
				...(captures ? [`-out:${outputPath}`] : []),
				...(linkerEnv ? linkerEnv.flags : []),
				...(useLldOnWindows ? ["-linker:lld"] : []),
				// Odin's own generated object code carries MSVC-style
				// /DEFAULTLIB directives that pull in MSVC's own static CRT
				// (libcmt.lib) alongside the mingw UCRT/runtime archives
				// gccWindowsRuntimeArchives() adds below — two incompatible C
				// runtimes in the same link, confirmed by a real `odin build`
				// failure: lld-link reported duplicate symbols between
				// libucrt.a and libcmt.lib, then failed outright on
				// libcmt-only CRT-init internals (__vcrt_initialize,
				// __acrt_initialize, ...) that mingw's runtime doesn't
				// provide. -no-crt stops Odin from auto-linking its own CRT,
				// leaving the mingw runtime archives as the only C runtime
				// in the link. Only applied when useMingwCrt is set (see its
				// own comment above) — by default, Odin's own MSVC CRT linking
				// is exactly what's needed, and the mingw runtime archives
				// below are skipped too rather than fighting it.
				...(useMingwCrt ? ["-no-crt"] : []),
				...(lint
					? []
					: odinExtraLinkerFlagsArgs([
							...resolved.analysis.linkopts,
							...(useMingwCrt
								? [
										// WinLibs' libstdc++.a defines __cxa_pure_virtual as a
										// plain (non-COMDAT) symbol in more than one object file
										// (e.g. eh_exception.o and system_error.o) — harmless
										// under GNU ld, which tolerates the duplicate, but a real
										// `odin build` failure showed lld-link rejecting it as
										// "duplicate symbol" once both objects get pulled in by a
										// large C++ dependency closure (BoringSSL + webview).
										// /force:multiple keeps lld-link's first definition and
										// only warns, matching GNU ld's existing tolerance.
										"/force:multiple",
										...gccWindowsRuntimeArchives(defaultGccToolchainVersion()),
									]
								: []),
						])),
			];
			const result = await exec.action({
				argv: args,
				cores: ODIN_CORES,
				inputs: allInputs,
				env: [
					`PATH=${[
						...(linkerEnv ? linkerEnv.pathDirs : []),
						odinGccLinkerPathDir(exec, resolved.gcc),
					].join(":")}`,
					...(test
						? odinTestLibraryPathEnv(
								(resolved.sharedLibResourceIndices || []).map((index) =>
									exec.path(resolved[`resource${index}`]),
								),
							)
						: []),
				],
				allowFailure: lint || test,
				outputs: captures ? { artifact: output.file(outputPath) } : {},
			});
			if (lint) {
				return {
					result: {
						ok: result.exitCode === 0,
						output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
						fixSupported: false,
						fixApplied: false,
					},
				};
			}
			if (test) {
				const ok = result.exitCode === 0;
				return {
					units: [
						{
							name: resolved.analysis.packagePath,
							ok,
							...(ok
								? {}
								: {
										output: [result.stdout, result.stderr]
											.filter(Boolean)
											.join("\n"),
									}),
						},
					],
				};
			}
			return { artifact: result.outputs.artifact, executablePath: outputPath };
		},
	});
}

// The workspace-built shared libraries this package's own dep closure
// contributed — the subset of graphResourceInputs()' resources that must also
// travel beside the executable at run time (see graphOdinBundle() below).
function graphSharedLibs(spec, analysis, config, analysisIndex) {
	const closure = graphSourceClosure(spec, analysis, config, analysisIndex);
	return graphResourceInputs([spec, ...closure.packages]).sharedLibs;
}

// A binary that links a workspace-built shared library needs that library
// beside it at run time. Odin already links with an `$ORIGIN` rpath of its own
// accord — measured on a real `odin build` as `RPATH [$ORIGIN]` under this
// workspace's own gcc toolchain, and as `RUNPATH [$ORIGIN]` under a host
// linker with new dtags — so the loader does look in the executable's own
// directory. What is missing is the library actually being there.
//
// So the product becomes a *directory* holding the executable plus every
// shared library the closure contributed, which is the same shape ccBinary()
// produces (see rules/c/index.js's own docstring and the decision entry
// binary-products-carry-shared-libraries). Only the copy is needed here, not
// the link flag: rules/c must pass -Wl,-rpath,$ORIGIN itself because it drives
// the linker directly, while Odin adds the rpath for every binary it builds.
//
// This is a task of its own, not one more command on the build action, because
// `odin build` is exec'd directly and not through `sh -c`: there is no script
// to append a `cp` to, and mergeDigests() merges trees at their declared paths
// and never relocates a file, so the executable and the library would stay in
// different directories. A separate action also keeps the hot compile action —
// with its Windows quoting and its PATH env — untouched.
//
// A binary with no shared dependency keeps the single-file product it has
// always had: nothing must travel beside it, and a different shape would move
// every packaged Odin binary's dist/ path for no gain. That is the same
// reasoning rules/c/index.js records for its own `bundled` condition.
//
// Two dependencies whose libraries share a basename overwrite each other here.
// That is the same collision the loader hits at run time, because DT_NEEDED
// carries only the basename, so a copy step cannot decide it.
function graphOdinBundle(
	spec,
	analysis,
	config,
	analysisIndex,
	build,
	exeName,
) {
	if (!analysis.hasMainEntrypoint) return null;
	const sharedLibs = graphSharedLibs(spec, analysis, config, analysisIndex);
	if (sharedLibs.length === 0) return null;
	const bundleDir = `build/odin/${addressSlug(spec.path)}.d`;
	return {
		bundleDir,
		exePath: `${bundleDir}/${exeName}`,
		task: task({
			display: `odin bundle ${analysis.packagePath}`,
			inputs: {
				artifact: build.outputs.artifact,
				mkdir: nativeTool("mkdir"),
				cp: nativeTool("cp"),
				bundleDir,
				exeName,
				...Object.fromEntries(
					sharedLibs.map((sharedLib, index) => [
						`sharedLib${index}`,
						sharedLib,
					]),
				),
			},
			outputs: { artifact: output.artifact() },
			async run(exec, input) {
				const libraryPaths = sharedLibs.map((_, index) =>
					exec.path(input[`sharedLib${index}`]),
				);
				const directory = shellQuote(input.bundleDir);
				const script = [
					`mkdir -p ${directory}`,
					`cp ${shellQuote(exec.path(input.artifact))} ${shellQuote(
						`${input.bundleDir}/${input.exeName}`,
					)}`,
					`cp ${libraryPaths.map(shellQuote).join(" ")} ${shellQuote(
						`${input.bundleDir}/`,
					)}`,
				].join("; ");
				const result = await exec.action({
					argv: ["sh", "-c", script],
					tools: [input.mkdir, input.cp],
					inputs: [
						input.artifact,
						...sharedLibs.map((_, index) => input[`sharedLib${index}`]),
					],
					outputs: { artifact: output.directory(input.bundleDir) },
					display: `odin bundle ${input.bundleDir}`,
				});
				return { artifact: result.outputs.artifact };
			},
		}),
	};
}

// The [RUN] root for a bundled binary. It runs nothing itself: it resolves the
// product directory into the `{digest, path}` description
// //rules/workflows/run stages and launches. A non-bundled Odin binary needs
// none of this — its product *is* the executable, which the run workflow
// accepts directly — but a directory is not a program, so a bundled one has to
// name the executable inside it. Mirrors ccBinary()'s own runDescriptor()
// (rules/c/index.js); `cache: false` for the same reason it uses there.
function graphOdinRunDescriptor(spec, analysis, bundle) {
	return task({
		display: `odin run ${analysis.packagePath}`,
		cache: false,
		inputs: { artifact: bundle.task.outputs.artifact, exePath: bundle.exePath },
		outputs: { run: output.value() },
		async run(_exec, input) {
			return { run: { digest: input.artifact.digest, path: input.exePath } };
		},
	});
}

function graphActions(spec, analysis, config, analysisIndex) {
	if (analysis.sourceFiles.length === 0) {
		throw new Error(
			empty_package_error({ attrs: {}, __id: spec.key }, spec.path, {
				test: spec.test,
			}),
		);
	}
	const build = graphOdinBuild(spec, analysis, config, analysisIndex);
	// A binary whose dep closure contributed a workspace-built shared library
	// gets a directory product that carries the library beside it; everything
	// else keeps the single-file product (see graphOdinBundle()).
	const bundle = graphOdinBundle(
		spec,
		analysis,
		config,
		analysisIndex,
		build,
		odinExeName(),
	);
	const product = bundle
		? bundle.task.outputs.artifact
		: build.outputs.artifact;
	const actions = {
		[BUILD]: product,
		[LINT]: graphOdinBuild(spec, analysis, config, analysisIndex, {
			lint: true,
		}).outputs.result,
		[PACKAGE]: product,
	};
	if (spec.test) {
		actions[TEST] = graphOdinBuild(spec, analysis, config, analysisIndex, {
			test: true,
		}).outputs.units;
	} else if (analysis.hasMainEntrypoint) {
		actions[RUN] = bundle
			? graphOdinRunDescriptor(spec, analysis, bundle).outputs.run
			: build.outputs.artifact;
	}
	return actions;
}

function graphRoot(spec, workflow) {
	return graphPackageExpansion(spec).get(spec.key, workflow);
}

function createGraphPackage({
	srcs = undefined,
	exclude = undefined,
	path = ".",
	collections = [],
	toolchain,
	deps = [],
	generatedSrcs = [],
	test = false,
	base = packagePath(),
	unsafeSystemPaths = false,
} = {}) {
	const normalizedSrcs =
		test && srcs === undefined
			? [...DEFAULT_TEST_PACKAGE_SRCS]
			: package_srcs({ srcs });
	const normalizedExclude =
		exclude === undefined ? (test ? [] : DEFAULT_PACKAGE_EXCLUDE) : exclude;
	const version = typeof toolchain === "string" ? toolchain : undefined;
	const packageId = ++graphPackageCounter;
	const spec = {
		__odin_graph_package: true,
		key: `package-${packageId}`,
		base,
		path: graphPath(base, path),
		srcs: normalizedSrcs,
		exclude: normalizedExclude,
		collections,
		deps: [...deps],
		test,
		toolchain:
			toolchain?.__imp_graph_handle === true
				? toolchain
				: version
					? odinGraphTool(version)
					: defaultOdinToolchain(),
		version,
		// Bypasses Bootlin's toolchain-wrapper unsafe-path guard for this
		// package's own linker invocation (see gccGraphTool()'s own
		// bin-unsafe-paths/ comment) — needed to link against a dep's
		// transitiveLinkopts pointing at host system packages like
		// libwebkit2gtk-4.1.
		unsafeSystemPaths: !!unsafeSystemPaths,
	};
	if (!spec.toolchain) {
		spec.toolchain = defaultOdinToolchain();
	}
	spec.sources = files({
		root: spec.path,
		include: spec.srcs,
		exclude: spec.exclude,
	});
	// Generated sources aren't workspace files, so they can't join spec.sources'
	// files() glob — each is declared as its own artifact input, paired with
	// the real path it's expected to land at, which is what makes
	// `odin build spec.path` see it as an ordinary package source once the
	// compile action mounts it there (see graphOdinBuild()'s own validation of
	// this contract). A codegen() result already carries workspace-relative
	// paths; the bare { artifact, path } form is package-relative and joined
	// here.
	spec.generatedSrcs = normalizeGeneratedSrcs(generatedSrcs, {
		rule: "odinPackage/odinTestPackage",
		resolvePath: (path) => graphPath(spec.path, path),
	});
	graphPackages.push(spec);
	const value = {
		__odin_graph_package: true,
		key: spec.key,
		sources: spec.sources,
		base: spec.base,
		version: spec.version,
		get [BUILD]() {
			return graphRoot(spec, BUILD);
		},
		get [LINT]() {
			return graphRoot(spec, LINT);
		},
		get [PACKAGE]() {
			return graphRoot(spec, PACKAGE);
		},
	};
	if (test)
		Object.defineProperty(value, TEST, {
			enumerable: true,
			get: () => graphRoot(spec, TEST),
		});
	else
		Object.defineProperty(value, RUN, {
			enumerable: true,
			get: () => graphRoot(spec, RUN),
		});
	for (const hook of graphPackageHooks)
		Object.assign(
			value,
			hook(Object.freeze({ ...value }), () => odinSourceAnalysis.outputs.index),
		);
	return Object.freeze(value);
}

/** Declare an immutable, graph-native Odin package. */
export function odinPackage(opts = {}) {
	return createGraphPackage(opts);
}

/** Declare an immutable, graph-native Odin test package. */
export function odinTestPackage(opts = {}) {
	return createGraphPackage({ ...opts, test: true });
}

export const odin_test_package = odinTestPackage;
