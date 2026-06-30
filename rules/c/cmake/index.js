import { target, glob, file_set, memo, output, output_path, product, run, targetAddress } from "imp:core";
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
// Path helpers (same pattern as rules/odin/index.js)
// ---------------------------------------------------------------------------

const DEFAULT_CPP_SRCS = ["CMakeLists.txt", "**/*.cpp", "**/*.h"];

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            throw new Error(`cmake paths must stay within the workspace: ${path}`);
        }
        parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
    if (!handle || handle.__imp !== true) return null;
    try {
        return targetAddress(handle);
    } catch (_) {
        return null;
    }
}

function declaring_directory(handle) {
    const address = safe_target_address(handle);
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

// ---------------------------------------------------------------------------
// Memo/product functions for C/CMake targets
// ---------------------------------------------------------------------------

export const tool = product("cmake-toolchain", "tool", async function tool(handle) {
    acquireCmakeToolchain(handle.attrs.version);
    return { name: "cmake", version: handle.attrs.version };
});

export const sources = memo(async function sources(handle) {
    const root = declared_path(handle, handle.attrs.src || ".");
    return glob({ root, include: handle.attrs.srcs || DEFAULT_CPP_SRCS });
});

export const native_link_library = product("cmake-lib", "native-link-library", async function native_link_library(handle) {
    const srcPath = declared_path(handle, handle.attrs.src || ".");
    const buildDirPath = handle.attrs.buildDir || `build/${srcPath === "." ? "cmake" : srcPath}`;
    const cmakeArgs = handle.attrs.cmakeArgs || [];
    const stageOutputs = handle.attrs.stageOutputs || [];
    const inputFiles = await sources(handle);
    const dirInputs = (handle.attrs.dirs || []).map(d => ({
        kind: "directory",
        path: declared_path(handle, d),
    }));

    const outputDecls = (handle.attrs.outputs || []).map(name =>
        output(output_path(`${srcPath}/${name}`))
    );
    const stagedOutputDecls = stageOutputs.map(({ to }) => output(output_path(to)));

    const stageCmds = stageOutputs.map(({ from, to }) =>
        `mkdir -p "$(dirname '${to}')" && cp '${srcPath}/${from}' '${to}'`
    );
    const stageScript = stageCmds.length > 0 ? " && " + stageCmds.join(" && ") : "";
    const script = `src=$1; bdir=$2; shift 2; mkdir -p "$bdir" && cmake -S "$src" -B "$bdir" "$@" && cmake --build "$bdir" -j1${stageScript}`;

    if (handle.attrs.toolchain) {
        return run({
            argv: ["sh", "-c", script, "cmake-build", srcPath, buildDirPath, ...cmakeArgs],
            tools: [cmakeTool(handle.attrs.toolchain)],
            inputs: [inputFiles, ...dirInputs],
            outputs: [...outputDecls, ...stagedOutputDecls],
            display: `cmake build ${srcPath}`,
        });
    }
    return run({
        argv: ["sh", "-c", script, "cmake-build", srcPath, buildDirPath, ...cmakeArgs],
        inputs: [inputFiles, ...dirInputs],
        outputs: [...outputDecls, ...stagedOutputDecls],
        display: `cmake build ${srcPath}`,
    });
});

// Returns link artifacts at their staged locations as a resource file set for
// odin package sandboxing. Also ensures the cmake build is a plan prerequisite.
export const cmake_resources = memo(async function cmake_resources(handle) {
    await native_link_library(handle);
    const stageOutputs = handle.attrs.stageOutputs || [];
    const linkFiles = stageOutputs
        .filter(({ from }) => /\.(so|dll|lib|dylib)$/.test(from))
        .map(({ to }) => to);
    return file_set.literal(linkFiles);
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", attrs: { sources: srcs } });
}

export function cmakeLib({
    src = ".",
    buildDir,
    srcs,
    dirs = [],
    cmakeArgs = [],
    outputs = [],
    stageOutputs = [],
    toolchain,
    deps = [],
}) {
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
            src,    // stored as user-provided; resolved by declared_path in product/memo
            srcs: srcs || DEFAULT_CPP_SRCS,
            ...(dirs.length ? { dirs } : {}),
            cmakeArgs,
            outputs,
            ...(stageOutputs.length ? { stageOutputs } : {}),
            ...(buildDir ? { buildDir } : {}),
            ...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
            ...(toolchainTarget ? { toolchainTarget } : {}),
            ...(allDeps.length ? { deps: allDeps.map(dep => dep.target || dep) } : {}),
        },
        deps: allDeps,
    });
}
