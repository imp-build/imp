import { target, glob, memo, product, run } from "imp:core";
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
// Memo/product functions for C/CMake targets
// ---------------------------------------------------------------------------

export const tool = product("cmake-toolchain", "tool", async function tool(handle) {
    acquireCmakeToolchain(handle.attrs.version);
    return { name: "cmake", version: handle.attrs.version };
});

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const native_link_library = product("cmake-lib", "native-link-library", async function native_link_library(handle) {
    const inputs = [];
    for (const dep of handle.attrs.deps || []) {
        if (dep && dep.kind === "cpp-sources") {
            inputs.push(await sources(dep));
        }
    }
    if (handle.attrs.toolchain) {
        return run({
            argv: ["cmake", "--build", handle.attrs.entrypoint],
            tools: [cmakeTool(handle.attrs.toolchain)],
            inputs,
            display: `cmake --build ${handle.attrs.entrypoint}`,
        });
    }
    return run({
        argv: [cmakeBin(), "--build", handle.attrs.entrypoint],
        inputs,
        display: `cmake --build ${handle.attrs.entrypoint}`,
    });
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", attrs: { sources: srcs } });
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
            ...(toolchainTarget ? { toolchainTarget } : {}),
            ...(allDeps.length ? { deps: allDeps.map(dep => dep.target || dep) } : {}),
        },
        deps: allDeps,
    });
}
