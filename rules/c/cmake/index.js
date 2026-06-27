import { target, rule } from "imp:core";
import { cmakeBin } from "//rules/c/cmake/toolchain";

export {
    acquireCmakeToolchain,
    cmakeBin,
    cmakeCacheKey,
    cmakeToolchain,
    createCmakeToolchainApi,
    defaultCmakeToolchainVersion,
    installCmakeToolchain,
    resolveCmakeToolchainVersion,
} from "//rules/c/cmake/toolchain";

// ---------------------------------------------------------------------------
// Exec functions for C/CMake rules
// ---------------------------------------------------------------------------

function snapshotSourcesExec(target, ctx) {
    // Sources are on disk; this task exists to wire up the dependency graph.
}

function cmakeBuildExec(target, ctx) {
    const result = ctx.run({
        argv: [cmakeBin(target.fields.toolchain), "--build", target.fields.entrypoint],
        display: `cmake --build ${target.fields.entrypoint}`,
    });
    if (result.exitCode !== 0) {
        throw new Error(`cmake build failed (exit ${result.exitCode}): ${result.stderr}`);
    }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

rule({
    kind: "cpp-sources",
    product: "sources",
    action: "snapshot {sources}",
    exec: snapshotSourcesExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "cmake-lib",
    product: "native-link-library",
    action: "cmake --build {entrypoint}",
    exec: cmakeBuildExec,
    requiresOwnSources: false,
    dependencyProduct: "sources",
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", fields: { sources: srcs.join(",") } });
}

export function cmakeLib({ entrypoint, toolchain, deps = [] }) {
    return target({
        kind: "cmake-lib",
        fields: {
            entrypoint,
            ...(toolchain ? { toolchain } : {}),
        },
        deps,
    });
}
