import {
	Target,
	glob,
	memo,
	registerBuildRule,
	sourcesField,
	targetAddress,
} from "imp:core";

// Not importing //rules/js/biome/index here: that module imports JsSources
// from this file to register its products, so importing it back would be a
// cycle. Product registration is instead pulled in by
// rules/workflows/fmt.js, the same wiring point rustfmt/ruff use.
export {
	BIOME_TOOL,
	biomeBin,
	biomeTool,
	biomeToolchain,
	defaultBiomeToolchain,
} from "//rules/js/biome_toolchain";

registerBuildRule({
	rule: "jsSources",
	importFrom: "//rules/js",
});

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/python/index.js and rules/odin/index.js)
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`js paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return targetAddress(handle);
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

// ---------------------------------------------------------------------------
// Memo functions
// ---------------------------------------------------------------------------

const JS_SOURCE_INCLUDES = [
	"package.json",
	"*.js",
	"*.jsx",
	"*.ts",
	"*.tsx",
	"*.json",
];

// Single-directory level only, never `**/` — a JsSources target owns
// exactly the files in its own declared directory, not any nested
// directory's files. Nested directories with their own sources are always
// their own separate jsSources target (same convention as odin's default
// `*.odin` package glob in rules/odin/index.js), so a glob here never
// crosses into another target's territory the way a recursive `**/*.js`
// would.
export const sources = memo(async function sources(handle) {
	const root = declared_path(handle, handle.attrs.src || ".");
	return glob({ root, include: JS_SOURCE_INCLUDES });
});

// Just the files a formatter rewrites, scoped to this target's own
// directory — narrower than sources() above, which also pulls in
// package.json as a build-time sandbox input. Same split as
// python_file_sources vs sources() in rules/python/index.js.
export const js_file_sources = memo(async function js_file_sources(handle) {
	const root = declared_path(handle, handle.attrs.src || ".");
	return glob({ root, include: ["*.js", "*.jsx", "*.ts", "*.tsx", "*.json"] });
});

// ---------------------------------------------------------------------------
// Target constructor
// ---------------------------------------------------------------------------

export class JsSources extends Target {
	static kind = "js-sources";
	constructor({ src = ".", deps = [] } = {}) {
		super({
			kind: JsSources.kind,
			attrs: { src },
			sources: sourcesField({ root: src, include: JS_SOURCE_INCLUDES }),
			deps,
		});
	}
}

/**
 * Declare a set of JavaScript/TypeScript source files.
 *
 * @category target
 * @param {object} [opts]
 * @param {string} [opts.src="."] Workspace-relative source directory.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Target handle.
 */
export function jsSources({ src, deps } = {}) {
	return new JsSources({ src, deps });
}
