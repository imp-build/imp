import {
	target,
	glob,
	file_set,
	paths,
	memo,
	output,
	output_path,
	product,
	run,
	logDebug,
} from "imp:core";

import {
    defaultOdinToolchain,
    odinTool,
    resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

export {
    acquireOdinToolchain,
    createOdinToolchainApi,
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


// ---------------------------------------------------------------------------
// Memo functions — source discovery
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

function declaring_directory(handle) {
    const address = handle && handle.label && handle.label.address;
    if (!address || !address.startsWith("//")) return ".";
    const scope = address.slice(2).split(":")[0];
    return scope.length === 0 ? "." : scope;
}

function declared_path(handle, path = ".") {
    const base = declaring_directory(handle);
    const local = path || ".";
    if (base === ".") return normalize_workspace_path(local);
    if (local === ".") return base;
    return normalize_workspace_path(`${base}/${local}`);
}

/**
 * Return a FileSet of the package's own source files.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const own_sources = memo(async function own_sources(handle) {
	logDebug(handle);
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: handle.attrs.srcs || [],
        exclude: handle.attrs.exclude || [],
    });
});

/**
 * Return a FileSet of the package's own sources plus all transitive odin-package dep sources.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const sources = memo(async function sources(handle) {
    const own = await own_sources(handle);
	logDebug( {own})
    const pkgDeps = (handle.attrs.deps || []).filter(h => h && h.kind === "odin-package");

    if (pkgDeps.length === 0) return own;
    const depSources = await Promise.all(pkgDeps.map(h => sources(h)));
    return file_set.union(own, ...depSources);
});

/**
 * Return the `-collection:name=path` flags for all collection deps of a package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<string[]>}
 */
export const collection_flags = memo(async function collection_flags(handle) {
    return (handle.attrs.collections || [])
        .map(col => `-collection:${col.attrs.name}=${declared_path(col, col.attrs.path)}`);
});

/**
 * Acquire the Odin toolchain and return a tool spec for sandbox use.
 *
 * @param {object} handle Target handle returned by odinToolchain().
 * @returns {Promise<object>} Tool spec.
 */
export const tool = memo(async function tool(handle) {
    return odinTool(handle.attrs.version);
});

function default_output_path(handle) {
    return `build/odin/${handle.label.name}`;
}

// ---------------------------------------------------------------------------
// Product functions
// ---------------------------------------------------------------------------

/**
 * Build an Odin package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} Run result.
 */
export const odinBuild = product("odin-package", "odin-package",
    async function odinBuild(handle) {
        const toolchainHandle = handle.attrs.toolchain;
        const odinToolSpec = toolchainHandle
            ? await tool(toolchainHandle)
            : odinTool(resolveOdinToolchainVersion(handle.attrs.toolchainVersion));
        const srcs = await sources(handle);
		logDebug(srcs);
        const flags = await collection_flags(handle);
        const path = declared_path(handle, handle.attrs.path || ".");
        const out = handle.attrs.output || default_output_path(handle);
        return run({
            argv: [
                "sh",
                "-c",
                "out=$1; pkg=$2; shift 2; mkdir -p \"$(dirname \"$out\")\" && odin build \"$pkg\" \"-out:$out\" \"$@\"",
                "odin-build",
                output_path(out),
                path,
                ...flags,
            ],
            tools: [odinToolSpec],
            inputs: [srcs],
            outputs: [output(out)],
            display: `odin build ${path}`,
        });
    }
);

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

/**
 * Declare an Odin collection namespace mapping.
 *
 * @param {object} opts
 * @param {string} opts.name Collection name, e.g. "lib".
 * @param {string} opts.path Workspace-relative collection path, e.g. "library".
 * @returns {object} Target handle.
 */
export function odinCollection({ name, path }) {
    if (!name || !path) {
        throw new Error("odinCollection({ name, path }) requires name and path");
    }
    return target({
        kind: "odin-collection",
        attrs: { name, path },
    });
}

/**
 * Declare an Odin package target.
 *
 * Sources are discovered lazily at build time via own_sources() / sources().
 *
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns matched against paths relative to opts.path.
 * @param {string[]} [opts.exclude=[]] Glob patterns to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]} [opts.collections=[]] Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {string} [opts.output] Workspace-relative executable output path.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs = [], exclude = [], path = ".", collections = [], toolchain, output, deps = [] }) {
    const toolchainHandle = toolchain && toolchain.__imp ? toolchain
                          : (typeof toolchain === "string" ? null : defaultOdinToolchain());
    const toolchainVersion = typeof toolchain === "string" ? toolchain : null;
    const normalizedDeps = deps
        .map(d => d && d.__imp ? d : (d && d.target ? d.target : null))
        .filter(Boolean);

    return target({
        kind: "odin-package",
        attrs: {
            path,
            srcs,
            ...(exclude.length ? { exclude } : {}),
            ...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
            ...(toolchainVersion ? { toolchainVersion } : {}),
            ...(output ? { output } : {}),
            ...(collections.length ? { collections } : {}),
            ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
        },
    });
}
