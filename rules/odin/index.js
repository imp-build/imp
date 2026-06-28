import {
	target,
	glob,
	file_set,
	paths,
	memo,
	product,
	run,
	hydrateTarget,
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
    const t = hydrateTarget(handle);
    return glob({
        root: t.fields.path || ".",
        include: JSON.parse(t.fields.srcs || "[]"),
        exclude: JSON.parse(t.fields.exclude || "[]"),
    });
});

/**
 * Return a FileSet of the package's own sources plus all transitive odin-package dep sources.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const sources = memo(async function sources(handle) {
    const t = hydrateTarget(handle);
    const own = await own_sources(handle);
    const pkg_deps = t.deps
        .map(d => d.handle)
        .filter(h => hydrateTarget(h).kind === "odin-package");
    if (pkg_deps.length === 0) return own;
    const dep_sources = await Promise.all(pkg_deps.map(h => sources(h)));
    return file_set.union(own, ...dep_sources);
});

/**
 * Return the `-collection:name=path` flags for all collection deps of a package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<string[]>}
 */
export const collection_flags = memo(async function collection_flags(handle) {
    const t = hydrateTarget(handle);
    return t.deps
        .filter(d => hydrateTarget(d.handle).kind === "odin-collection")
        .map(d => {
            const col = hydrateTarget(d.handle);
            return `-collection:${col.fields.name}=${col.fields.path}`;
        });
});

/**
 * Acquire the Odin toolchain and return a tool spec for sandbox use.
 *
 * @param {object} handle Target handle returned by odinToolchain().
 * @returns {Promise<object>} Tool spec.
 */
export const tool = memo(async function tool(handle) {
    const t = hydrateTarget(handle);
    return odinTool(t.fields.version);
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
        const t = hydrateTarget(handle);
        const toolchain_dep = t.deps.find(d => hydrateTarget(d.handle).kind === "odin-toolchain");
        const odin_tool = toolchain_dep
            ? await tool(toolchain_dep.handle)
            : odinTool(resolveOdinToolchainVersion(t.fields.toolchain));
        const srcs = await sources(handle);
        const flags = await collection_flags(handle);
        const path = t.fields.path || ".";
        return run({
            argv: ["odin", "build", path, ...flags],
            tools: [odin_tool],
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
    const collection = target({
        kind: "odin-collection",
        fields: {
            name,
            path,
        },
    });
    collection.name = name;
    collection.path = path;
    collection.flag = `-collection:${name}=${path}`;
    return collection;
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
    const explicitToolchainTarget = toolchain && toolchain.__imp === true ? toolchain : null;
    const explicitVersion = toolchain && toolchain.__imp !== true ? toolchain : null;
    const toolchainTarget = explicitToolchainTarget || (!explicitVersion ? defaultOdinToolchain() : null);
    const toolchainVersion = explicitVersion || (toolchainTarget && toolchainTarget.version);
    const collectionFlags = collections.map((collection) => collection.flag);
    const collectionDeps = collections.map((collection) => ({ target: collection, mode: "collection" }));
    const packageDeps = deps
        .map(d => d && d.__imp ? { target: d } : (d && d.target ? d : null))
        .filter(Boolean);
    const allDeps = toolchainTarget
        ? [{ target: toolchainTarget, mode: "tool" }, ...collectionDeps, ...packageDeps]
        : [...collectionDeps, ...packageDeps];

    const pkg = target({
        kind: "odin-package",
        fields: {
            path,
            srcs: JSON.stringify(srcs),
            exclude: JSON.stringify(exclude),
            ...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
        },
        deps: allDeps,
    });
    pkg.toolchainVersion = toolchainVersion || null;
    pkg.toolchainTarget = toolchainTarget || null;
    pkg.collections = collections;
    pkg.collectionFlags = collectionFlags;
    pkg.collectionCount = collections.length;
    pkg.dependencyCount = allDeps.length;
    return pkg;
}
