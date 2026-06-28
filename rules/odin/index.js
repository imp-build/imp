import {
	target,
	rule,
	glob,
	file_set,
	paths,
	memo,
	hydrateTarget,
	gatherTransitiveClosure,
	casTreeStore,
	casTreeMerge,
} from "imp:core";

import {
    acquireOdinToolchain,
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

// ---------------------------------------------------------------------------
// Exec functions
// ---------------------------------------------------------------------------

function odinToolchainExec(target, ctx) {
    acquireOdinToolchain(target.fields.version);
}

function odinCollectionExec(target, ctx) {
    // A collection target is a namespace mapping such as `lib=library`.
    // It intentionally does not model or own the packages below that path.
}

async function odinBuildExec(target, ctx) {
    const srcs = await sources(target.handle);
    const file_inputs = paths(srcs).map(p => ({ kind: "file", path: p }));
    const version = resolveOdinToolchainVersion(target.fields && target.fields.toolchain);
    const odin = await ctx.tool(odinTool(version));
    const collectionFlags = target.fields.collections
        ? target.fields.collections.split(",").filter(Boolean)
        : [];
    const result = await ctx.inSandbox({
        argv: ["odin", "build", target.fields.path || "."].concat(collectionFlags),
        tools: [odin],
        display: `odin build ${target.target}`,
        inputs: file_inputs,
    });
    if (result.exitCode !== 0) {
        throw new Error(`odin build failed (exit ${result.exitCode}): ${result.stderr}`);
    }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

rule({
    kind: "odin-toolchain",
    product: "tool",
    action: "install odin {version}",
    exec: odinToolchainExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "odin-collection",
    product: "collection",
    action: "odin collection {name}={path}",
    exec: odinCollectionExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "odin-package",
    product: "odin-package",
    action: { display: "odin build {path}" },
    exec: odinBuildExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

/**
 * Declare an Odin collection namespace mapping.
 *
 * This target represents only the compiler flag `-collection:name=path`.
 * It does not depend on, contain, or own the packages below `path`; package
 * dependencies should be discovered from imports or declared separately.
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
            ...(collectionFlags.length ? { collections: collectionFlags.join(",") } : {}),
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
