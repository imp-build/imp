import {
	BUILD,
	Target,
	files,
	glob,
	memo,
	packagePath,
	registerBuildRule,
	sourcesField,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";

// resourcePackage remains registered for generated legacy BUILD.js files until
// the remaining legacy rulesets have migrated to graph handles (#39).

registerBuildRule({
	rule: "resourcePackage",
	importFrom: "//rules/asset",
});

const shell = nativeTool("sh");

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(
				`resourcePackage paths must stay within the workspace: ${path}`,
			);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function declared_workspace_path(base, path = ".") {
	if (typeof base !== "string") {
		throw new Error("asset({ base }) expects a workspace-relative string");
	}
	const normalizedBase = normalize_workspace_path(base);
	const local = path || ".";
	if (normalizedBase === ".") return normalize_workspace_path(local);
	if (local === ".") return normalizedBase;
	return normalize_workspace_path(`${normalizedBase}/${local}`);
}

function source_files({ srcs, exclude = [], path = ".", base = packagePath() }, api) {
	if (!Array.isArray(srcs)) {
		throw new Error(`${api}({ srcs }) requires source glob patterns`);
	}
	if (!Array.isArray(exclude)) {
		throw new Error(`${api}({ exclude }) expects an array`);
	}
	if (typeof path !== "string") {
		throw new Error(`${api}({ path }) expects a string`);
	}
	return files({
		root: declared_workspace_path(base, path),
		include: srcs,
		exclude,
	});
}

/**
 * Declare a graph-native asset source collection and validation build action.
 *
 * @category graph
 * @param {object} opts
 * @param {string[]} opts.srcs Source glob patterns, relative to `base`.
 * @param {string} [opts.base=packagePath()] Workspace-relative source base. Pass this explicitly through BUILD helpers.
 * @returns {{sources: object, [BUILD]: object}} Graph source and build handles.
 */
export function asset({ srcs, base = packagePath() }) {
	const sources = source_files({ srcs, base }, "asset");
	const build = task({
		display: "bundle assets",
		cache: false,
		inputs: { sources, shell },
		async run(exec, inputs) {
			await exec.action({
				argv: [exec.tool(inputs.shell, "sh"), "-c", "true"],
				inputs: [inputs.sources],
				cache: false,
			});
		},
	});
	return Object.freeze({ sources, [BUILD]: build });
}

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return handle.label.address;
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

function legacy_declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

// Temporary legacy adapter for Rust and Odin. New graph rules consume the
// immutable `.files` handle directly; #39 removes this Target carrier.
export const resources = memo(
	async function resources(handle) {
		return glob({
			root: legacy_declared_path(handle, handle.attrs.path || "."),
			include: handle.attrs.srcs || [],
			exclude: handle.attrs.exclude || [],
		});
	},
	{ display: "asset resources {0}", level: "debug" },
);

export class ResourcePackage extends Target {
	static kind = "resource-package";
	constructor({ srcs, exclude = [], path = ".", base = packagePath() }) {
		if (!Array.isArray(srcs) || srcs.length === 0) {
			throw new Error(
				"resourcePackage({ srcs }) requires one or more source glob patterns",
			);
		}
		const graphFiles = source_files(
			{ srcs, exclude, path, base },
			"resourcePackage",
		);
		super({
			kind: ResourcePackage.kind,
			attrs: {
				path,
				srcs,
				...(exclude.length ? { exclude } : {}),
			},
			sources: sourcesField({ root: path, include: srcs, exclude }),
		});
		Object.defineProperty(this, "files", {
			value: graphFiles,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}
}

/**
 * Declare resources staged at a BUILD-relative path. During the migration,
 * the returned object remains usable as a legacy dependency and exposes its
 * graph-native source collection as `.files`.
 *
 * @category graph
 * @param {object} opts
 * @param {string[]} opts.srcs Source glob patterns to include (required, non-empty).
 * @param {string[]} [opts.exclude] Glob patterns to exclude from `srcs`.
 * @param {string} [opts.path] Directory relative to `base`.
 * @param {string} [opts.base=packagePath()] Workspace-relative source base. Pass this explicitly through BUILD helpers.
 * @returns {ResourcePackage} Legacy-compatible object with a graph `.files` handle.
 */
export function resourcePackage({
	srcs,
	exclude = [],
	path = ".",
	base = packagePath(),
}) {
	return new ResourcePackage({ srcs, exclude, path, base });
}
