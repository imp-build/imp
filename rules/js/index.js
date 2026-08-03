import {
	extensible,
	glob,
	label,
	labelAddress,
	memo,
	registerBuildRule,
} from "imp:core";

registerBuildRule({
	rule: "jsSources",
	importFrom: "//rules/js",
});

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/rust/index.js and rules/python/index.js)
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

export function jsSourcesAddress(handle) {
	try {
		if (handle && handle.__imp_label) return labelAddress(handle);
		if (handle && handle.label && handle.label.__imp_label) {
			return labelAddress(handle.label);
		}
		return null;
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = jsSourcesAddress(handle);
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

export function normalize_deps(deps) {
	return (deps || [])
		.map((d) =>
			d && (d.__imp || d.__imp_label) ? d : d && d.target ? d.target : null,
		)
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Action-handle shim
// ---------------------------------------------------------------------------

function package_handle(srcLabel) {
	if (!srcLabel || srcLabel.__imp_label !== true) return srcLabel;
	return {
		__id: srcLabel.__id,
		label: srcLabel,
		attrs: srcLabel.attrs,
		deps: (srcLabel.data.deps || []).map((target) => ({ handle: target })),
	};
}

export const jsSourcesActionHandle = package_handle;

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

// Single-directory level only, never `**/` — a jsSources label owns exactly
// the files in its own declared directory, not any nested directory's files.
// Nested directories with their own sources are always their own separate
// jsSources label (same convention as odin's default `*.odin` package glob
// in rules/odin/index.js), so a glob here never crosses into another
// label's territory the way a recursive `**/*.js` would.
export const sources = memo(
	async function sources(handle) {
		handle = package_handle(handle);
		const root = declared_path(handle, handle.attrs.src || ".");
		return glob({ root, include: JS_SOURCE_INCLUDES });
	},
	{ display: "sources {0}", level: "debug" },
);

// Just the files a formatter rewrites, scoped to this label's own
// directory — narrower than sources() above, which also pulls in
// package.json as a build-time sandbox input. Same split as
// python_file_sources vs sources() in rules/python/index.js.
export const js_file_sources = memo(
	async function js_file_sources(handle) {
		handle = package_handle(handle);
		const root = declared_path(handle, handle.attrs.src || ".");
		return glob({
			root,
			include: ["*.js", "*.jsx", "*.ts", "*.tsx", "*.json"],
		});
	},
	{ display: "js file sources {0}", level: "debug" },
);

// ---------------------------------------------------------------------------
// Label factory
// ---------------------------------------------------------------------------

/**
 * Declare a set of JavaScript/TypeScript source files.
 *
 * @category target
 * @param {object} [opts]
 * @param {string} [opts.src="."] Workspace-relative source directory.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Label handle.
 */
export const jsSources = extensible(function jsSources({
	src = ".",
	deps = [],
} = {}) {
	return label({
		data: {
			src: normalize_workspace_path(src),
			deps: normalize_deps(deps),
		},
	});
});
