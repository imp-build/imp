import { target, rule, workspaceSourceEntries, casTreeStore, casTreeMerge, hydrateTarget, gatherTransitiveClosure } from "imp:core";
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
// Exec functions
// ---------------------------------------------------------------------------

function sourceSetExec(target, ctx) {
    const entries = workspaceSourceEntries({
        root: target.fields.root || ".",
        include: target.fields.include.split(","),
        exclude: target.fields.exclude ? target.fields.exclude.split(",") : [],
    });
    ctx.output(casTreeStore(entries));
}

function snapshotSourcesExec(target, ctx) {
    ctx.output(casTreeMerge(...target.depOutputs));
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
    const manifest = JSON.parse(target.fields.sourceManifestValue);
    const sourceInputs = manifest.cas.map((entry) => ({ kind: "file", path: entry.path }));
    const result = await ctx.inSandbox({
        argv: ["odin", "build", "."],
        tools: [odin],
        display: `odin build ${target.target}`,
        inputs: sourceInputs,
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
    kind: "source-set",
    product: "sources",
    action: { display: "capture sources {root}" },
    exec: sourceSetExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "odin-package",
    product: "sources",
    action: { display: "snapshot sources {path}" },
    exec: snapshotSourcesExec,
    requiresOwnSources: false,
    dependencyProduct: "sources",
});

rule({
    kind: "odin-package",
    product: "odin-package",
    action: {
        display: "odin build",
        inputs: [{
            kind: "manifest",
            path: "{sourceManifest}",
        }],
    },
    exec: odinBuildExec,
    requiresOwnSources: true,
    dependencyProduct: "default",
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

let nextSourceSet = 0;

function stableHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceManifestPath(root, include, exclude) {
    const key = JSON.stringify({ root, include, exclude });
    return `.imp/sources/${stableHash(key)}-${nextSourceSet++}.json`;
}

/**
 * Capture workspace source files into a manifest artifact.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Rust regular expressions matched against workspace-relative paths.
 * @param {string[]} [opts.exclude=[]] Rust regular expressions to remove matches.
 * @returns {object} Target handle.
 */
export function readSources({ root = ".", include, exclude = [] }) {
    if (!Array.isArray(include) || include.length === 0) {
        throw new Error("readSources({ include }) requires at least one include regex");
    }
    const sourceEntries = workspaceSourceEntries({ root, include, exclude });
    const files = sourceEntries.map((entry) => entry.path);
    const sourceManifest = sourceManifestPath(root, include, exclude);
    const sourceManifestValue = `${JSON.stringify({
        version: 1,
        root,
        include,
        exclude,
        files,
        cas: sourceEntries,
    }, null, 2)}\n`;
    const sources = target({
        kind: "source-set",
        fields: {
            root,
            include: include.join(","),
            exclude: exclude.join(","),
            files: files.join(","),
            sourceManifest,
            sourceManifestValue,
        },
    });
    sources.root = root;
    sources.include = include;
    sources.exclude = exclude;
    sources.files = files;
    sources.cas = sourceEntries;
    sources.sourceManifest = sourceManifest;
    sources.sourceManifestValue = sourceManifestValue;
    return sources;
}

/**
 * Merge multiple source artifacts into one.
 *
 * @param {...object} artifacts Source artifacts returned by readSources() or merge().
 * @returns {object} A new source-set artifact whose CAS entries are the union of all inputs.
 * @throws {Error} If any two inputs contain the same path.
 */
export function merge(...artifacts) {
    const seen = new Map();
    for (const artifact of artifacts) {
        for (const entry of artifact.cas) {
            const existing = seen.get(entry.path);
            if (existing !== undefined) {
                if (existing.digest !== entry.digest) {
                    throw new Error(`merge: conflicting content for path '${entry.path}'`);
                }
                continue;
            }
            seen.set(entry.path, entry);
        }
    }
    const cas = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const files = cas.map((e) => e.path);
    const key = JSON.stringify(artifacts.map((a) => a.sourceManifest));
    const sourceManifest = `.imp/sources/${stableHash(key)}-${nextSourceSet++}.json`;
    const sourceManifestValue = `${JSON.stringify({
        version: 1,
        merged: artifacts.map((a) => a.sourceManifest),
        files,
        cas,
    }, null, 2)}\n`;
    const sources = target({
        kind: "source-set",
        fields: {
            files: files.join(","),
            sourceManifest,
            sourceManifestValue,
        },
    });
    sources.files = files;
    sources.cas = cas;
    sources.sourceManifest = sourceManifest;
    sources.sourceManifestValue = sourceManifestValue;
    return sources;
}

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
 * @param {string[]} [opts.srcs] Odin source regexes, matched against workspace-relative paths.
 * @param {object} [opts.sources] Source target returned from readSources().
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]} [opts.collections=[]] Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs, sources, path = ".", collections = [], toolchain, deps = [] }) {
    const sourceTarget = sources || readSources({ root: path, include: srcs });
    const explicitToolchainTarget = toolchain && toolchain.__imp === true ? toolchain : null;
    const explicitVersion = toolchain && toolchain.__imp !== true ? toolchain : null;
    const toolchainTarget = explicitToolchainTarget || (!explicitVersion ? defaultOdinToolchain() : null);
    const toolchainVersion = explicitVersion || (toolchainTarget && toolchainTarget.version);
    const collectionFlags = collections.map((collection) => collection.flag);
    const collectionDeps = collections.map((collection) => ({ target: collection, mode: "collection" }));
    const sourceDep = { target: sourceTarget, mode: "sources" };
    const allDeps = toolchainTarget
        ? [{ target: toolchainTarget, mode: "tool" }, sourceDep, ...collectionDeps, ...deps]
        : [sourceDep, ...collectionDeps, ...deps];

    // Accumulate transitive sources from odin-package deps.
    const odinDepSources = deps
        .map((d) => (d && d.__imp ? d : (d && d.target ? d.target : null)))
        .filter((h) => h && h.__imp && hydrateTarget(h).kind === "odin-package")
        .map((h) => h.transitiveSources)
        .filter(Boolean);
    const transitiveSources = odinDepSources.length > 0
        ? merge(sourceTarget, ...odinDepSources)
        : sourceTarget;

    const pkg = target({
        kind: "odin-package",
        fields: {
            path,
            sources: sourceTarget.files.join(","),
            sourceManifest: transitiveSources.sourceManifest,
            sourceManifestValue: transitiveSources.sourceManifestValue,
            ...(collectionFlags.length ? { collections: collectionFlags.join(",") } : {}),
            ...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
        },
        deps: allDeps,
    });
    pkg.toolchainVersion = toolchainVersion || null;
    pkg.toolchainTarget = toolchainTarget || null;
    pkg.sourcesTarget = sourceTarget;
    pkg.transitiveSources = transitiveSources;
    pkg.sourceManifest = transitiveSources.sourceManifest;
    pkg.collections = collections;
    pkg.collectionFlags = collectionFlags;
    pkg.collectionCount = collections.length;
    pkg.dependencyCount = allDeps.length;
    return pkg;
}
