import { Target, glob, file_set, memo, output, output_path, product, readFileInDigest, run, targetAddress } from "imp:core";
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
import {
    extractCopyDestinations,
    parseNinja,
    reachableEdges,
    rebasePath,
    resolveEdgeCommand,
    sandboxRootFromWorkdir,
} from "//rules/c/cmake/ninja_graph";

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

// Conservative header-change safety net for the per-edge graph replay below:
// Ninja's static build graph doesn't expose header dependencies (those are
// only known via the depfile a compile produces — a universal property of
// the C preprocessor, not something any CMake generator exposes statically).
// Declaring just this narrower header-only glob as an extra input on every
// compile edge (instead of the whole `sources` set) means editing one .c
// file only invalidates that file's own edge, while editing any header
// conservatively invalidates every compile edge — safe, if coarser than a
// real per-header dependency scan (a `cc -MM`-based follow-up would narrow
// this further).
const headerSources = memo(async function headerSources(handle) {
    const root = declared_path(handle, handle.attrs.src || ".");
    return glob({ root, include: ["**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx"] });
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

// Configures the project with CMake's Ninja generator (needs no `ninja`
// binary installed — CMake's own code emits build.ninja/rules.ninja; we
// only ever read that graph, never execute it via ninja) and parses it.
//
// The configure `run()` is itself a normal content-keyed task-cache entry
// (inputs: sources + dirs), so an unchanged project skips reconfiguring
// entirely rather than paying for it on every build/test.
async function configureNinjaGraph(handle, setup) {
    const { srcPath, buildDirPath, cmakeArgs, inputFiles, dirInputs, cmakeToolSpec, compilerTools, compilerArgs } = setup;

    const script = 'src=$1; bdir=$2; shift 2; mkdir -p "$bdir" && cmake -S "$src" -B "$bdir" -G Ninja "$@"';
    const configureTools = [
        await nativeToolSpec(nativeTool("mkdir")),
        // CMake's Ninja generator needs a real `ninja` (or ninja-compatible)
        // binary resolvable at configure time to populate
        // CMAKE_MAKE_PROGRAM, even though we never invoke it ourselves —
        // we only ever read the generated build.ninja/rules.ninja text.
        await nativeToolSpec(nativeTool("ninja")),
        ...(handle.attrs.compiler ? [await nativeToolSpec(nativeTool("dirname"))] : []),
    ];

    const configureResult = await run({
        argv: ["sh", "-c", script, "cmake-configure", srcPath, buildDirPath, ...compilerArgs, ...cmakeArgs],
        tools: [cmakeToolSpec, ...compilerTools, ...configureTools],
        inputs: [inputFiles, ...dirInputs],
        outputs: [output(output_path(buildDirPath), { kind: "directory" })],
        materialize: true,
        display: `cmake configure ${srcPath}`,
    });

    const readAt = path => readFileInDigest(configureResult.outputDigest, `${buildDirPath}/${path}`);
    const buildNinjaText = readAt("build.ninja");
    const { rules, edges, topVars } = parseNinja(buildNinjaText, readAt);
    const sandboxRoot = sandboxRootFromWorkdir(topVars.cmake_ninja_workdir, buildDirPath);

    return { rules, edges, topVars, sandboxRoot };
}

// Replays every build edge reachable from `targetNames` (e.g. "all") as its
// own run() call, so an unchanged source file's compile edge is a
// task-cache hit and gets skipped instead of the whole project rebuilding
// as one atomic unit — the graph-lift this file exists for. Each edge
// materializes its output(s) into the real buildDirPath, so downstream
// edges (and the caller, once this returns) find them at their normal
// on-disk build-directory locations, same as a plain `cmake --build` would
// leave behind.
async function replayReachableGraph(handle, setup, graph, targetNames) {
    const { buildDirPath, cmakeToolSpec, compilerTools, dirInputs } = setup;
    const { rules, edges, topVars, sandboxRoot } = graph;
    // Always available on PATH for every edge, matching exactly what
    // configure itself used — needed for tool names that only resolve
    // through a pinned toolchain's own mount (e.g. a Zig compiler's
    // "zigar"/"zigranlib" wrapper scripts), not via a fresh host PATH
    // lookup.
    // The zigar/zigranlib wrapper scripts a Zig compiler toolchain
    // generates shell out to `dirname` internally — invisible to the
    // per-edge toolName extraction below since it never appears in the
    // edge's own resolved command text.
    const baseTools = [
        cmakeToolSpec,
        ...compilerTools,
        ...(handle.attrs.compiler ? [await nativeToolSpec(nativeTool("dirname"))] : []),
    ];
    const baseToolNames = new Set(baseTools.map(t => t.name));

    // The full walk (including phony/bookkeeping edges) is needed to
    // classify dependency paths correctly below — a phony edge's "output"
    // (e.g. CMake's internal order-only markers like
    // "cmake_object_order_depends_target_core") isn't a real file, but it's
    // also not a leaf input; it must be skipped entirely rather than
    // mistaken for either. Only the non-phony, has-a-command subset is
    // actually replayed as run() calls.
    const allReached = reachableEdges(edges, targetNames);
    const nonExecutableOutputs = new Set(
        allReached
            .filter(edge => edge.rule === "phony" || !rules[edge.rule] || !rules[edge.rule].command)
            .flatMap(edge => [...edge.outputs, ...edge.implicitOutputs]),
    );
    const reached = allReached.filter(edge => edge.rule !== "phony" && rules[edge.rule] && rules[edge.rule].command);
    const headerFiles = await headerSources(handle);

    // A dependency-produced input (depEdgeInputs below) references another
    // edge's materialized output as a plain workspace path, not a digest
    // chained from that edge's own run() result — so nothing enforces
    // ordering automatically. Edges must run in topological waves: an
    // edge's dependencies (other *replayed* edges producing one of its
    // inputs) have to finish materializing before it starts, but edges
    // with no such dependency on each other are safe to run concurrently.
    //
    // Dependencies can chain *through* phony/order-only markers (e.g.
    // CMake's "cmake_object_order_depends_target_X" edges) rather than
    // referencing a real edge's output directly — levelOf walks the full
    // graph (allReached, not just the executable subset) and treats a
    // phony edge as a zero-cost passthrough to its own dependencies,
    // instead of a dead end, so a transitive real dependency reached only
    // through a chain of phony markers still forces the correct wave.
    const allByOutput = new Map();
    for (const edge of allReached) {
        for (const p of [...edge.outputs, ...edge.implicitOutputs]) {
            allByOutput.set(p, edge);
        }
    }
    const isExecutable = edge => edge.rule !== "phony" && Boolean(rules[edge.rule]) && Boolean(rules[edge.rule].command);
    const levels = new Map();
    function levelOf(edge) {
        if (levels.has(edge)) return levels.get(edge);
        let depLevel = 0;
        for (const dep of [...edge.inputs, ...edge.implicitInputs, ...edge.orderOnly]) {
            const depEdge = allByOutput.get(dep);
            if (depEdge && depEdge !== edge) {
                depLevel = Math.max(depLevel, levelOf(depEdge));
            }
        }
        const level = isExecutable(edge) ? depLevel + 1 : depLevel;
        levels.set(edge, level);
        return level;
    }
    const waves = [];
    for (const edge of reached) {
        const level = levelOf(edge);
        (waves[level] || (waves[level] = [])).push(edge);
    }

    async function executeEdge(edge) {
        const resolved = resolveEdgeCommand(edge, rules, topVars, sandboxRoot, buildDirPath);
        if (!resolved) return;

        // resolved.toolNames only ever contains names rewritten from a
        // genuine absolute host path (e.g. "/usr/bin/ar") — imp's own
        // ".imp/tools/..." mount paths (e.g. a Zig toolchain's
        // "zigar"/"zigranlib") are rewritten to bare names too, but
        // deliberately excluded from toolNames there, since they're never
        // real host-wide binaries and always already covered by
        // cmakeToolSpec/compilerTools. See rewriteToolInvocations.
        const edgeTools = [...baseTools];
        for (const name of resolved.toolNames) {
            if (baseToolNames.has(name)) continue;
            edgeTools.push(await nativeToolSpec(nativeTool(name)));
        }

        const depEdgeInputs = [];
        const leafInputs = [];
        for (const dep of [...edge.inputs, ...edge.implicitInputs, ...edge.orderOnly]) {
            const isAbsolute = Boolean(sandboxRoot) && dep.startsWith(sandboxRoot + "/");
            if (isAbsolute) {
                // A real external source file (CMake canonicalizes
                // CMAKE_SOURCE_DIR references to absolute paths).
                leafInputs.push({ kind: "file", path: rebasePath(dep, sandboxRoot) });
            } else if (nonExecutableOutputs.has(dep)) {
                // Phony/bookkeeping marker — not a real file. Topological
                // wave ordering already satisfies whatever it was ordering.
                continue;
            } else {
                // Build-dir-relative: either produced by an earlier
                // replayed edge (materialized at this same path — the wave
                // ordering above guarantees it already ran), or generated
                // directly by CMake at configure time (e.g. a
                // precompiled-header shim like cmake_pch.hxx) and already
                // written to disk by configure's own materialize:true —
                // either way it's a plain file sitting at buildDirPath.
                depEdgeInputs.push({ kind: "file", path: `${buildDirPath}/${dep}` });
            }
        }

        // Edges with a depfile are real C/C++ compiles with dynamic header
        // deps not visible in the static graph — see headerSources' doc
        // comment for the conservative-widening rationale. Declared `dirs`
        // (e.g. a vendored third-party include tree like Jolt) aren't
        // covered by that project-local header glob at all, so they need
        // to be mounted too — every compile edge gets the same extra
        // directories the old single-run() build always mounted, since we
        // don't parse -I flags to know which edge actually needs which one.
        const isCompileEdge = Boolean(edge.vars.DEP_FILE || rules[edge.rule].depfile);

        const outputPaths = [...edge.outputs, ...edge.implicitOutputs];
        // A POST_BUILD/PRE_LINK custom command (e.g. a `cmake -E copy` to
        // stage the built artifact into the source tree) isn't modeled as
        // its own ninja edge/output at all — it only shows up baked into
        // this edge's resolved command text. Without declaring its
        // destination as an output too, the file would be created inside
        // this edge's own ephemeral sandbox and then discarded when the
        // sandbox is torn down, instead of materializing to the real
        // workspace like the old single-run() build always did for free.
        const copyOutputs = extractCopyDestinations(resolved.command, buildDirPath);

        // Ninja always executes edges with cwd = the build directory (see
        // resolveEdgeCommand's doc comment) — resolved.command's paths are
        // already rebased on that assumption, so replicate it here.
        const cdCommand = `cd '${buildDirPath}' && ${resolved.command}`;
        return run({
            argv: ["sh", "-c", cdCommand],
            tools: edgeTools,
            inputs: [...leafInputs, ...depEdgeInputs, ...(isCompileEdge ? [headerFiles, ...dirInputs] : [])],
            outputs: [
                ...outputPaths.map(p => output(output_path(`${buildDirPath}/${p}`))),
                ...copyOutputs.map(p => output(output_path(p))),
            ],
            materialize: true,
            display: `cmake edge ${outputPaths[0] || edge.rule}`,
        });
    }

    for (const wave of waves) {
        if (!wave) continue;
        await Promise.all(wave.map(executeEdge));
    }
}

export const native_link_library = product("cmake-lib", "build", async function native_link_library(handle) {
    const setup = await resolveCmakeSetup(handle);
    const { srcPath, buildDirPath } = setup;
    const stageOutputs = handle.attrs.stageOutputs || [];

    const graph = await configureNinjaGraph(handle, setup);
    await replayReachableGraph(handle, setup, graph, ["all"]);

    // outputs/stageOutputs name files relative to srcPath, matching how
    // this attr has always worked — many real CMakeLists.txt files (e.g.
    // via a POST_BUILD `cmake -E copy` custom command) stage their built
    // artifact into the source tree themselves, rather than leaving it at
    // its plain buildDirPath location. The graph replay's extractCopyDestinations
    // handling ensures that side effect is actually captured back to the
    // real workspace now that it isn't one big monolithic sandboxed build.
    const outputDecls = (handle.attrs.outputs || []).map(name =>
        output(output_path(`${srcPath}/${name}`))
    );
    const stagedOutputDecls = stageOutputs.map(({ to }) => output(output_path(to)));

    const stageCmds = stageOutputs.map(({ from, to }) =>
        `mkdir -p "$(dirname '${to}')" && cp '${srcPath}/${from}' '${to}'`
    );
    const script = stageCmds.length > 0 ? stageCmds.join(" && ") : ":";
    const scriptTools = [
        ...(stageOutputs.length > 0 ? [
            await nativeToolSpec(nativeTool("mkdir")),
            await nativeToolSpec(nativeTool("cp")),
            await nativeToolSpec(nativeTool("dirname")),
        ] : []),
    ];

    // Mount the specific files staging reads, rather than the whole
    // srcPath directory — srcPath is "." for the (very common) case of a
    // cmakeLib rooted at its own BUILD.js directory, and a bare "." isn't
    // a valid directory-input path (it has no real path components once
    // normalized).
    const srcFileInputs = [
        ...(handle.attrs.outputs || []).map(name => ({ kind: "file", path: `${srcPath}/${name}` })),
        ...stageOutputs.map(({ from }) => ({ kind: "file", path: `${srcPath}/${from}` })),
    ];

    return run({
        argv: ["sh", "-c", script, "cmake-stage"],
        tools: scriptTools,
        inputs: [...srcFileInputs, { kind: "directory", path: buildDirPath }],
        outputs: [...outputDecls, ...stagedOutputDecls],
        materialize: true,
        display: `cmake stage ${srcPath}`,
    });
});

// Runs the project's ctest suite. Framework-agnostic by construction: CMake's
// `add_test()` is how Unity, Catch2, GoogleTest, and doctest all register
// tests, so ctest itself is the generic runner — no per-framework detection
// needed here.
//
// Builds via the same per-edge graph replay as native_link_library (so an
// unchanged source file's compile edge is a cache hit instead of the whole
// suite rebuilding), then runs ctest itself as one final impure step against
// the resulting build directory.
export const ctest = product("cmake-lib", "test", async function ctest(handle) {
    const setup = await resolveCmakeSetup(handle);
    const { srcPath, buildDirPath } = setup;
    const ctestArgs = handle.attrs.ctestArgs || [];

    const graph = await configureNinjaGraph(handle, setup);
    await replayReachableGraph(handle, setup, graph, ["all"]);

    // CTestTestfile.cmake (generated at configure time) bakes in the
    // *configure* sandbox's absolute root as each test's executable path —
    // the same absolute-sandbox-root problem the graph replay works around
    // for build.ninja, but ctest reads this file directly at runtime, so it
    // has to be patched in place instead: substitute the old (configure)
    // sandbox root for this run's real, current one (only knowable from
    // inside the sandbox itself, via `pwd`) before invoking ctest.
    const script = 'oldroot=$1; bdir=$2; shift 2; ' +
        'newroot=$(pwd); ' +
        'find "$bdir" -name CTestTestfile.cmake -exec sed -i "s#$oldroot#$newroot#g" {} + ; ' +
        'ctest --test-dir "$bdir" "$@"';

    // No outputs/materialize on this final step: test results aren't
    // user-addressable artifacts. impure: true so a re-run always executes
    // the suite rather than replaying a cached pass/fail from the task
    // cache — same choice cargoTest/odinTest make.
    return run({
        argv: ["sh", "-c", script, "cmake-test", graph.sandboxRoot || "", buildDirPath, ...ctestArgs],
        tools: [
            await nativeToolSpec(nativeTool("ctest")),
            await nativeToolSpec(nativeTool("find")),
            await nativeToolSpec(nativeTool("sed")),
        ],
        inputs: [{ kind: "directory", path: buildDirPath }],
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
