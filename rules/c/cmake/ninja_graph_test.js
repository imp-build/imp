import { describe, expect, test } from "//rules/imp/test";
import {
    expandVar,
    parseNinja,
    reachableEdges,
    rebaseAbsolutePaths,
    resolveEdgeCommand,
    rewriteToolInvocations,
    sandboxRootFromWorkdir,
} from "//rules/c/cmake/ninja_graph";

// Fixture shape mirrors a real `cmake -S . -B build -G Ninja` probe of a
// project with one static lib (core), one executable (app) linking it, and
// a ctest suite — trimmed to the edges that matter, using a fabricated
// sandbox root so path-rebasing is exercised deterministically.
const SANDBOX_ROOT = "/sandbox-42-999-1";

const RULES_NINJA = `
rule C_COMPILER__core_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = ${"$"}{LAUNCHER}${"$"}{CODE_CHECK}/usr/bin/cc $DEFINES $INCLUDES $FLAGS -MD -MT $out -MF $DEP_FILE -o $out -c $in
  description = Building C object $out

rule C_STATIC_LIBRARY_LINKER__core_
  command = $PRE_LINK && /usr/bin/cmake -E rm -f $TARGET_FILE && /usr/bin/ar qc $TARGET_FILE $LINK_FLAGS $in && /usr/bin/ranlib $TARGET_FILE && $POST_BUILD
  description = Linking C static library $TARGET_FILE

rule C_COMPILER__app_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = ${"$"}{LAUNCHER}${"$"}{CODE_CHECK}/usr/bin/cc $DEFINES $INCLUDES $FLAGS -MD -MT $out -MF $DEP_FILE -o $out -c $in
  description = Building C object $out

rule C_EXECUTABLE_LINKER__app_
  command = $PRE_LINK && /usr/bin/cc $FLAGS $LINK_FLAGS $in -o $TARGET_FILE $LINK_PATH $LINK_LIBRARIES && $POST_BUILD
  description = Linking C executable $TARGET_FILE

rule CUSTOM_COMMAND
  command = $COMMAND
  description = $DESC

rule RERUN_CMAKE
  command = /usr/bin/cmake --regenerate-during-build -S${SANDBOX_ROOT} -B${SANDBOX_ROOT}/build
  description = Re-running CMake...
  generator = 1

rule CLEAN
  command = /usr/bin/ninja -t clean

rule HELP
  command = /usr/bin/ninja -t targets
`;

const BUILD_NINJA = `
ninja_required_version = 1.5

include CMakeFiles/rules.ninja

cmake_ninja_workdir = ${SANDBOX_ROOT}/build/

build CMakeFiles/core.dir/src/core.c.o: C_COMPILER__core_unscanned_ ${SANDBOX_ROOT}/src/core.c
  DEP_FILE = CMakeFiles/core.dir/src/core.c.o.d
  INCLUDES = -I${SANDBOX_ROOT}/src
  OBJECT_DIR = CMakeFiles/core.dir

build libcore.a: C_STATIC_LIBRARY_LINKER__core_ CMakeFiles/core.dir/src/core.c.o
  TARGET_FILE = libcore.a
  OBJECT_DIR = CMakeFiles/core.dir
  PRE_LINK = :
  POST_BUILD = :

build CMakeFiles/app.dir/src/main.c.o: C_COMPILER__app_unscanned_ ${SANDBOX_ROOT}/src/main.c
  DEP_FILE = CMakeFiles/app.dir/src/main.c.o.d
  INCLUDES = -I${SANDBOX_ROOT}/src
  OBJECT_DIR = CMakeFiles/app.dir

build app: C_EXECUTABLE_LINKER__app_ CMakeFiles/app.dir/src/main.c.o | libcore.a
  TARGET_FILE = app
  LINK_LIBRARIES = libcore.a

build CMakeFiles/test.util: CUSTOM_COMMAND
  COMMAND = cd ${SANDBOX_ROOT}/build && /usr/bin/ctest --force-new-ctest-process
  DESC = Running tests...

build test: phony CMakeFiles/test.util

build CMakeFiles/edit_cache.util: CUSTOM_COMMAND
  COMMAND = cd ${SANDBOX_ROOT}/build && /usr/bin/cmake -E echo No dialog
  DESC = No interactive CMake dialog available...

build edit_cache: phony CMakeFiles/edit_cache.util

build CMakeFiles/rebuild_cache.util: CUSTOM_COMMAND
  COMMAND = cd ${SANDBOX_ROOT}/build && /usr/bin/cmake --regenerate-during-build

build rebuild_cache: phony CMakeFiles/rebuild_cache.util

build core: phony libcore.a

build all: phony libcore.a app

build build.ninja: RERUN_CMAKE ${SANDBOX_ROOT}/CMakeLists.txt

build clean: CLEAN

build help: HELP
`;

function readInclude(path) {
    if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
    throw new Error(`unexpected include: ${path}`);
}

describe("ninja_graph parser", () => {
    test("parses rules and build edges, following include", () => {
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);

        expect(Object.keys(rules).sort().join(",")).toBe(
            [
                "CLEAN", "CUSTOM_COMMAND", "C_COMPILER__app_unscanned_",
                "C_COMPILER__core_unscanned_", "C_EXECUTABLE_LINKER__app_",
                "C_STATIC_LIBRARY_LINKER__core_", "HELP", "RERUN_CMAKE",
            ].sort().join(","),
        );
        expect(topVars.cmake_ninja_workdir).toBe(`${SANDBOX_ROOT}/build/`);

        const coreObj = edges.find(e => e.outputs.includes("CMakeFiles/core.dir/src/core.c.o"));
        expect(coreObj.rule).toBe("C_COMPILER__core_unscanned_");
        expect(coreObj.inputs).toEqual([`${SANDBOX_ROOT}/src/core.c`]);
        expect(coreObj.vars.DEP_FILE).toBe("CMakeFiles/core.dir/src/core.c.o.d");
    });

    test("parses implicit and order-only dependency edges (|, ||)", () => {
        const { edges } = parseNinja(BUILD_NINJA, readInclude);
        const appLink = edges.find(e => e.outputs.includes("app"));
        expect(appLink.inputs).toEqual(["CMakeFiles/app.dir/src/main.c.o"]);
        expect(appLink.implicitInputs).toEqual(["libcore.a"]);
    });
});

describe("ninja_graph reachability", () => {
    test("reaches only the real compile/link edges from 'all', in dependency order", () => {
        const { edges } = parseNinja(BUILD_NINJA, readInclude);
        // phony edges (like "all" itself) are aliases, not real commands —
        // callers filter them out before generating run() calls.
        const reached = reachableEdges(edges, ["all"]).filter(e => e.rule !== "phony");
        const outputs = reached.map(e => e.outputs[0] || e.implicitOutputs[0]);

        expect(outputs).toEqual([
            "CMakeFiles/core.dir/src/core.c.o",
            "libcore.a",
            "CMakeFiles/app.dir/src/main.c.o",
            "app",
        ]);
    });

    test("excludes CMake bookkeeping edges entirely", () => {
        const { edges } = parseNinja(BUILD_NINJA, readInclude);
        const reached = reachableEdges(edges, ["all"]);
        const rules = new Set(reached.map(e => e.rule));

        expect(rules.has("RERUN_CMAKE")).toBe(false);
        expect(rules.has("CLEAN")).toBe(false);
        expect(rules.has("HELP")).toBe(false);
        expect(rules.has("CUSTOM_COMMAND")).toBe(false);
    });
});

describe("ninja_graph command resolution", () => {
    test("expands $in/$out and edge-scoped vars", () => {
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);
        const coreObj = edges.find(e => e.outputs.includes("CMakeFiles/core.dir/src/core.c.o"));
        const expanded = expandVar(rules[coreObj.rule].command, coreObj, topVars, rules[coreObj.rule]);

        expect(expanded).toContain(`-c ${SANDBOX_ROOT}/src/core.c`);
        expect(expanded).toContain("-o CMakeFiles/core.dir/src/core.c.o");
        expect(expanded).toContain(`-I${SANDBOX_ROOT}/src`);
    });

    test("rebases the configure sandbox's absolute root to workspace-relative", () => {
        const root = sandboxRootFromWorkdir(`${SANDBOX_ROOT}/build/`, "build");
        expect(root).toBe(SANDBOX_ROOT);

        const rebased = rebaseAbsolutePaths(`-I${SANDBOX_ROOT}/src -c ${SANDBOX_ROOT}/src/core.c`, root);
        expect(rebased).toBe("-Isrc -c src/core.c");
    });

    test("rewrites command-position absolute tool paths to bare names, leaves argument paths alone", () => {
        const { command, toolNames } = rewriteToolInvocations(
            "/usr/bin/cc -Isrc -MD -MT out.o -MF out.o.d -o out.o -c /abs/src/core.c",
        );
        expect(command).toBe("cc -Isrc -MD -MT out.o -MF out.o.d -o out.o -c /abs/src/core.c");
        expect(toolNames).toEqual(["cc"]);
    });

    test("rewrites every chained invocation after && but not their arguments", () => {
        const { command, toolNames } = rewriteToolInvocations(
            ": && /usr/bin/cmake -E rm -f libcore.a && /usr/bin/ar qc libcore.a obj.o && /usr/bin/ranlib libcore.a && :",
        );
        expect(command).toBe(": && cmake -E rm -f libcore.a && ar qc libcore.a obj.o && ranlib libcore.a && :");
        expect(toolNames.sort()).toEqual(["ar", "cmake", "ranlib"]);
    });

    test("resolveEdgeCommand combines expansion, rebasing (relative to build dir), and tool rewriting", () => {
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);
        const coreObj = edges.find(e => e.outputs.includes("CMakeFiles/core.dir/src/core.c.o"));
        const root = sandboxRootFromWorkdir(topVars.cmake_ninja_workdir, "build");

        // Ninja always executes commands with cwd = the build directory, so
        // a rebased source path must climb back out of it — "build" is one
        // level deep, hence a single "../".
        const { command, toolNames } = resolveEdgeCommand(coreObj, rules, topVars, root, "build");

        expect(command).toContain("cc ");
        expect(command).not.toContain(SANDBOX_ROOT);
        expect(command).toContain("-c ../src/core.c");
        expect(toolNames).toEqual(["cc"]);
    });

    test("resolveEdgeCommand rewrites imp's own relative tool-mount paths too", () => {
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);
        const coreObj = edges.find(e => e.outputs.includes("CMakeFiles/core.dir/src/core.c.o"));
        const zigRule = { ...rules[coreObj.rule], command: rules[coreObj.rule].command.replace("/usr/bin/cc", ".imp/tools/zig/zig cc") };
        const rulesWithZig = { ...rules, [coreObj.rule]: zigRule };
        const root = sandboxRootFromWorkdir(topVars.cmake_ninja_workdir, "build");

        const { command, toolNames } = resolveEdgeCommand(coreObj, rulesWithZig, topVars, root, "build");

        expect(command).toContain("zig cc ");
        expect(command).not.toContain(".imp/tools");
        // "zig" is never a real host-wide binary — it only exists inside
        // the toolchain's own mounted directory, already covered by
        // compilerTools, so it must NOT trigger a fresh nativeTool() PATH
        // lookup (which would always fail for a name like "zigranlib").
        expect(toolNames).toEqual([]);
    });

    test("resolveEdgeCommand rewrites imp tool-mount paths even after CMake canonicalized them to absolute", () => {
        // CMAKE_AR/CMAKE_RANLIB (declared as the relative
        // ".imp/tools/zig/zigar") get canonicalized to absolute by CMake
        // at configure time, so they show up prefixed with the configure
        // sandbox's root — rebasing turns that back into a build-dir-
        // relative "../../.imp/tools/zig/zigar", which must still be
        // recognized as a tool invocation, not left as a literal path.
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);
        const libEdge = edges.find(e => e.outputs.includes("libcore.a"));
        const zigRule = {
            ...rules[libEdge.rule],
            command: rules[libEdge.rule].command.replace("/usr/bin/ar", `${SANDBOX_ROOT}/.imp/tools/zig/zigar`),
        };
        const rulesWithZig = { ...rules, [libEdge.rule]: zigRule };
        const root = sandboxRootFromWorkdir(topVars.cmake_ninja_workdir, "build");

        const { command, toolNames } = resolveEdgeCommand(libEdge, rulesWithZig, topVars, root, "build");

        expect(command).toContain("zigar qc");
        expect(command).not.toContain(".imp/tools/zig/zigar ");
        // Same reasoning as above: "zigar" must never be sent through a
        // fresh nativeTool() PATH lookup.
        expect(toolNames).not.toContain("zigar");
    });

    test("resolveEdgeCommand handles the static-library link edge's multi-command chain", () => {
        const { rules, edges, topVars } = parseNinja(BUILD_NINJA, readInclude);
        const libEdge = edges.find(e => e.outputs.includes("libcore.a"));
        const root = sandboxRootFromWorkdir(topVars.cmake_ninja_workdir, "build");

        const { command, toolNames } = resolveEdgeCommand(libEdge, rules, topVars, root, "build");

        expect(command).toBe(": && cmake -E rm -f libcore.a && ar qc libcore.a  CMakeFiles/core.dir/src/core.c.o && ranlib libcore.a && :");
        expect(toolNames.sort()).toEqual(["ar", "cmake", "ranlib"]);
    });
});
