import { target, rule } from "imp:core";
import { odinBin, resolveOdinToolchainVersion } from "//rules/odin/toolchain";

export {
    acquireOdinToolchain,
    createOdinToolchainApi,
    defaultOdinToolchainVersion,
    odinArtifactName,
    odinBin,
    odinCacheKey,
    odinDownloadUrl,
    odinToolchain,
    resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

// ---------------------------------------------------------------------------
// Exec functions for odin-package rules
// ---------------------------------------------------------------------------

function snapshotSourcesExec(target, ctx) {
    // Sources are on disk; this task exists to wire up the dependency graph
    // so the odin-build task waits for dependency resolution.
}

function odinBuildExec(target, ctx) {
    const version = resolveOdinToolchainVersion(target.fields && target.fields.toolchain);
    const bin = odinBin(version);
    const result = ctx.run({
        argv: [bin, "build", "."],
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
 * Declare an Odin package target.
 *
 * @param {object} opts
 * @param {string[]} opts.srcs Odin source files.
 * @param {string} [opts.toolchain] Odin toolchain version. Uses the default if set.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs, toolchain, deps = [] }) {
    return target({
        kind: "odin-package",
        fields: {
            sources: srcs.join(","),
            ...(toolchain ? { toolchain } : {}),
        },
        deps,
    });
}
