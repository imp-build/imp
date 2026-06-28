import { target, rule } from "imp:core";
import {
    acquireCmakeToolchain,
    cmakeBin,
    cmakeTool,
    defaultCmakeToolchain,
} from "//rules/c/cmake/toolchain";

export {
    acquireCmakeToolchain,
    cmakeBin,
    cmakeCacheKey,
    cmakeTool,
    cmakeToolchain,
    createCmakeToolchainApi,
    defaultCmakeToolchain,
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

function cmakeToolchainExec(target, ctx) {
    acquireCmakeToolchain(target.fields.version);
}

async function cmakeBuildExec(target, ctx) {
    let result;
    if (target.fields.toolchain) {
        const cmake = await ctx.tool(cmakeTool(target.fields.toolchain));
        result = await ctx.inSandbox({
            argv: ["cmake", "--build", target.fields.entrypoint],
            tools: [cmake],
            display: `cmake --build ${target.fields.entrypoint}`,
        });
    } else {
        result = ctx.run({
            argv: [cmakeBin(), "--build", target.fields.entrypoint],
            display: `cmake --build ${target.fields.entrypoint}`,
        });
    }
    if (result.exitCode !== 0) {
        throw new Error(`cmake build failed (exit ${result.exitCode}): ${result.stderr}`);
    }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

rule({
    kind: "cmake-toolchain",
    product: "tool",
    action: "install cmake {version}",
    exec: cmakeToolchainExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

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
    return target({ kind: "cpp-sources", attrs: { sources: srcs.join(",") } });
}

export function cmakeLib({ entrypoint, toolchain, deps = [] }) {
    const explicitToolchainTarget = toolchain && toolchain.__imp === true ? toolchain : null;
    const explicitVersion = toolchain && toolchain.__imp !== true ? toolchain : null;
    const toolchainTarget = explicitToolchainTarget || (!explicitVersion ? defaultCmakeToolchain() : null);
    const toolchainVersion = explicitVersion || (toolchainTarget && toolchainTarget.attrs?.version);
    const allDeps = toolchainTarget
        ? [{ target: toolchainTarget, mode: "tool" }, ...deps]
        : deps;

    return target({
        kind: "cmake-lib",
        attrs: {
            entrypoint,
            ...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
        },
        deps: allDeps,
    });
}
