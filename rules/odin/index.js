import {
	target,
	glob,
	file_set,
	paths,
	memo,
	product,
	run,
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

/**
 * Return a FileSet of the package's own source files.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const own_sources = memo(async function own_sources(handle) {
    return glob({
        root: handle.attrs.path || ".",
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
    return (handle.attrs.collections || []).map(col => `-collection:${col.attrs.name}=${col.attrs.path}`);
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
        const flags = await collection_flags(handle);
        const path = handle.attrs.path || ".";
        return run({
            argv: ["odin", "build", path, ...flags],
            tools: [odinToolSpec],
            inputs: [srcs],
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
 * @param {string[]} [opts.srcs=[]] Rust regexes matched against workspace-relative paths.
 * @param {string[]} [opts.exclude=[]] Rust regexes to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]} [opts.collections=[]] Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs = [], exclude = [], path = ".", collections = [], toolchain, deps = [] }) {
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
            ...(collections.length ? { collections } : {}),
            ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
        },
    });
}
