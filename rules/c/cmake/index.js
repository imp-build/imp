import { Target, glob, file_set, memo, output, output_path, product, run, targetAddress } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
    acquireCmakeToolchain,
    cmakeBin,
    cmakeTool,
    defaultCmakeToolchain,
} from "//rules/c/cmake/toolchain";
import {
    zigTool,
    zigCMakeArgs,
    defaultZigToolchain,
} from "//rules/c/zig/toolchain";

// Registers the "build" goal's artifact summary callback for consumers that
// import CMake build rules without importing the workflows layer explicitly.
import "//rules/workflows/build";

export {
    acquireCmakeToolchain,
    cmakeBin,
    cmakeCacheKey,
    cmakeTool,
    cmakeToolchain,
    defaultCmakeToolchain,
    defaultCmakeToolchainVersion,
    installCmakeToolchain,
    resolveCmakeToolchainVersion,
} from "//rules/c/cmake/toolchain";

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/odin/index.js)
// ---------------------------------------------------------------------------

const DEFAULT_CPP_SRCS = ["CMakeLists.txt", "**/*.c", "**/*.cpp", "**/*.h"];

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

export const tool = product("cmake-toolchain", "build", async function tool(handle) {
    await acquireCmakeToolchain(handle.attrs.version);
    return { name: "cmake", version: handle.attrs.version };
});

export const sources = memo(async function sources(handle) {
    const root = declared_path(handle, handle.attrs.src || ".");
    return glob({ root, include: handle.attrs.srcs || DEFAULT_CPP_SRCS });
});

// Shared path/toolchain/input resolution for both the "build" and "test"
// products below — factors out everything that doesn't depend on whether
// we're building or (re-)running ctest.
async function resolveCmakeSetup(handle) {
    const srcPath = declared_path(handle, handle.attrs.src || ".");
    const buildDirPath = handle.attrs.buildDir || `build/${srcPath === "." ? "cmake" : srcPath}`;
    const cmakeArgs = handle.attrs.cmakeArgs || [];
    const inputFiles = await sources(handle);
    const dirInputs = (handle.attrs.dirs || []).map(d => ({
        kind: "directory",
        path: declared_path(handle, d),
    }));

    // No pinned toolchain declared — still need a resolved cmake so the
    // hermetic sandbox can find it (bare "cmake" has no PATH entry
    // otherwise).
    const cmakeToolSpec = handle.attrs.toolchain
        ? await cmakeTool(handle.attrs.toolchain)
        : await nativeToolSpec(nativeTool("cmake"));
    const compilerTools = handle.attrs.compiler ? [await zigTool(handle.attrs.compiler)] : [];
    const compilerArgs = handle.attrs.compiler ? await zigCMakeArgs(handle.attrs.compiler) : [];

    return { srcPath, buildDirPath, cmakeArgs, inputFiles, dirInputs, cmakeToolSpec, compilerTools, compilerArgs };
}

export const native_link_library = product("cmake-lib", "build", async function native_link_library(handle) {
    const { srcPath, buildDirPath, cmakeArgs, inputFiles, dirInputs, cmakeToolSpec, compilerTools, compilerArgs } =
        await resolveCmakeSetup(handle);
    const stageOutputs = handle.attrs.stageOutputs || [];

    const outputDecls = (handle.attrs.outputs || []).map(name =>
        output(output_path(`${srcPath}/${name}`))
    );
    const stagedOutputDecls = stageOutputs.map(({ to }) => output(output_path(to)));

    const stageCmds = stageOutputs.map(({ from, to }) =>
        `mkdir -p "$(dirname '${to}')" && cp '${srcPath}/${from}' '${to}'`
    );
    const stageScript = stageCmds.length > 0 ? " && " + stageCmds.join(" && ") : "";
    const script = `src=$1; bdir=$2; shift 2; mkdir -p "$bdir" && cmake -S "$src" -B "$bdir" "$@" && cmake --build "$bdir" -j10${stageScript}`;

    // The script itself shells out to mkdir (always) and cp (only when
    // staging outputs); cmake's default "Unix Makefiles" generator also
    // shells out to `make` to actually build, and (when a Zig compiler is
    // wired in) the generated zigar/zigranlib wrapper scripts shell out to
    // `dirname` — all need declaring, same as any other command in the
    // fully hermetic sandbox.
    const scriptTools = [
        await nativeToolSpec(nativeTool("mkdir")),
        await nativeToolSpec(nativeTool("make")),
        ...(stageOutputs.length > 0 ? [await nativeToolSpec(nativeTool("cp"))] : []),
        ...(handle.attrs.compiler ? [await nativeToolSpec(nativeTool("dirname"))] : []),
    ];

    return run({
        argv: ["sh", "-c", script, "cmake-build", srcPath, buildDirPath, ...compilerArgs, ...cmakeArgs],
        tools: [cmakeToolSpec, ...compilerTools, ...scriptTools],
        inputs: [inputFiles, ...dirInputs],
        outputs: [...outputDecls, ...stagedOutputDecls],
        materialize: true,
        display: `cmake build ${srcPath}`,
    });
});

// Runs the project's ctest suite. Framework-agnostic by construction: CMake's
// `add_test()` is how Unity, Catch2, GoogleTest, and doctest all register
// tests, so ctest itself is the generic runner — no per-framework detection
// needed here.
//
// Self-contained (configure + build + ctest in one run()), rather than
// reusing native_link_library's build directory: each run() call executes in
// a fresh sandbox populated only from declared inputs, and only declared
// outputs survive it, so a second run() call can't see the first one's
// undeclared build artifacts without wiring the whole build directory as a
// shared directory output/input. Just redoing the (incremental, cmake-cached)
// configure+build here — same tradeoff cargoTest makes by rerunning
// `cargo test` rather than reusing cargoBuild's outputs.
export const ctest = product("cmake-lib", "test", async function ctest(handle) {
    const { srcPath, buildDirPath, cmakeArgs, inputFiles, dirInputs, cmakeToolSpec, compilerTools, compilerArgs } =
        await resolveCmakeSetup(handle);
    const ctestArgs = handle.attrs.ctestArgs || [];
    const configureArgCount = compilerArgs.length + cmakeArgs.length;

    // ncmake tells the script where the configure-time args end and the
    // ctest-invocation args begin within the flattened positional list.
    const script = 'src=$1; bdir=$2; ncmake=$3; shift 3; ' +
        'i=0; cmake_args=; while [ "$i" -lt "$ncmake" ]; do cmake_args="$cmake_args $1"; shift; i=$((i+1)); done; ' +
        'mkdir -p "$bdir" && cmake -S "$src" -B "$bdir" $cmake_args && cmake --build "$bdir" -j10 && ctest --test-dir "$bdir" "$@"';

    const scriptTools = [
        await nativeToolSpec(nativeTool("mkdir")),
        await nativeToolSpec(nativeTool("make")),
        await nativeToolSpec(nativeTool("ctest")),
        ...(handle.attrs.compiler ? [await nativeToolSpec(nativeTool("dirname"))] : []),
    ];

    // No outputs/materialize: test binaries aren't user-addressable
    // artifacts. impure: true so a re-run always executes the suite rather
    // than replaying a cached pass/fail from the task cache — same choice
    // cargoTest/odinTest make.
    return run({
        argv: [
            "sh", "-c", script, "cmake-test",
            srcPath, buildDirPath, String(configureArgCount),
            ...compilerArgs, ...cmakeArgs,
            ...ctestArgs,
        ],
        tools: [cmakeToolSpec, ...compilerTools, ...scriptTools],
        inputs: [inputFiles, ...dirInputs],
        impure: true,
        display: `ctest ${srcPath}`,
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

export class CppSources extends Target {
    static kind = "cpp-sources";
    constructor({ srcs }) {
        super({ kind: CppSources.kind, attrs: { sources: srcs } });
    }
}

export function cppSources({ srcs }) {
    return new CppSources({ srcs });
}

export class CmakeLib extends Target {
    static kind = "cmake-lib";
    constructor({
        src = ".",
        buildDir,
        srcs,
        dirs = [],
        cmakeArgs = [],
        ctestArgs = [],
        outputs = [],
        stageOutputs = [],
        toolchain,
        compiler,
        deps = [],
    }) {
        const explicitToolchainTarget = toolchain && toolchain.__imp === true ? toolchain : null;
        const explicitVersion = toolchain && toolchain.__imp !== true ? toolchain : null;
        const toolchainTarget = explicitToolchainTarget || (!explicitVersion ? defaultCmakeToolchain() : null);
        const toolchainVersion = explicitVersion || (toolchainTarget && toolchainTarget.attrs?.version);

        const explicitCompilerTarget = compiler && compiler.__imp === true ? compiler : null;
        const explicitCompilerVersion = compiler && compiler.__imp !== true ? compiler : null;
        const compilerTarget = explicitCompilerTarget || (!explicitCompilerVersion ? defaultZigToolchain() : null);
        const compilerVersion = explicitCompilerVersion || (compilerTarget && compilerTarget.attrs?.version);

        const allDeps = [
            ...(toolchainTarget ? [{ target: toolchainTarget, mode: "tool" }] : []),
            ...(compilerTarget ? [{ target: compilerTarget, mode: "tool" }] : []),
            ...deps,
        ];

        super({
            kind: CmakeLib.kind,
            attrs: {
                src,    // stored as user-provided; resolved by declared_path in product/memo
                srcs: srcs || DEFAULT_CPP_SRCS,
                ...(dirs.length ? { dirs } : {}),
                cmakeArgs,
                ...(ctestArgs.length ? { ctestArgs } : {}),
                outputs,
                ...(stageOutputs.length ? { stageOutputs } : {}),
                ...(buildDir ? { buildDir } : {}),
                ...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
                ...(toolchainTarget ? { toolchainTarget } : {}),
                ...(compilerVersion ? { compiler: compilerVersion } : {}),
                ...(compilerTarget ? { compilerTarget } : {}),
                ...(allDeps.length ? { deps: allDeps.map(dep => dep.target || dep) } : {}),
            },
            deps: allDeps,
        });
    }
}

export function cmakeLib({
    src = ".",
    buildDir,
    srcs,
    dirs = [],
    cmakeArgs = [],
    ctestArgs = [],
    outputs = [],
    stageOutputs = [],
    toolchain,
    compiler,
    deps = [],
}) {
    return new CmakeLib({
        src, buildDir, srcs, dirs, cmakeArgs, ctestArgs, outputs, stageOutputs, toolchain, compiler, deps,
    });
}
