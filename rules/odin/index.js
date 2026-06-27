import { target, rule } from "imp:core";
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
// Exec functions for odin-package rules
// ---------------------------------------------------------------------------

function snapshotSourcesExec(target, ctx) {
    // Sources are on disk; this task exists to wire up the dependency graph
    // so the odin-build task waits for dependency resolution.
}

function odinToolchainExec(target, ctx) {
    acquireOdinToolchain(target.fields.version);
}

function odinCollectionExec(target, ctx) {
    // A collection target is a namespace mapping such as `lib=library`.
    // It intentionally does not model or own the packages below that path.
}

async function odinBuildExec(target, ctx) {
    const version = resolveOdinToolchainVersion(target.fields && target.fields.toolchain);
    const odin = await ctx.tool(odinTool(version));
    const result = await ctx.inSandbox({
        argv: ["odin", "build", "."],
        tools: [odin],
        display: `odin build ${target.target}`,
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
    product: "sources",
    action: "snapshot {sources}",
    exec: snapshotSourcesExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "odin-package",
    product: "odin-package",
    action: "odin build",
    exec: odinBuildExec,
    requiresOwnSources: true,
    dependencyProduct: "default",
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
 * @param {object} opts
 * @param {string[]} opts.srcs Odin source files.
 * @param {object[]} [opts.collections=[]] Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs, collections = [], toolchain, deps = [] }) {
    const explicitToolchainTarget = toolchain && toolchain.__imp === true ? toolchain : null;
    const explicitVersion = toolchain && toolchain.__imp !== true ? toolchain : null;
    const toolchainTarget = explicitToolchainTarget || (!explicitVersion ? defaultOdinToolchain() : null);
    const toolchainVersion = explicitVersion || (toolchainTarget && toolchainTarget.version);
    const collectionFlags = collections.map((collection) => collection.flag);
    const collectionDeps = collections.map((collection) => ({ target: collection, mode: "collection" }));
    const allDeps = toolchainTarget
        ? [{ target: toolchainTarget, mode: "tool" }, ...collectionDeps, ...deps]
        : [...collectionDeps, ...deps];

    const pkg = target({
        kind: "odin-package",
        fields: {
            sources: srcs.join(","),
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
