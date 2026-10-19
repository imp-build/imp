import { output, resolveGraphHandle, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { describe, expect, test } from "//rules/imp/test";
import { scanCmakeCompilerInputs } from "//rules/c/cmake/graph_replay";
import { parseNinja } from "//rules/c/cmake/ninja_graph";

const ROOT = "cmake-scan-fixture";
const BUILD_DIR = `${ROOT}/build`;
const SOURCE = `${ROOT}/source.c`;
const HEADER = `${ROOT}/used.h`;
const BUILD_NINJA = `include CMakeFiles/rules.ninja
build obj: C_COMPILER__probe /oldroot/cmake-scan-fixture/source.c
  DEP_FILE = obj.d

build build.ninja: RERUN_CMAKE /missing-configure-input

`;
const RULES_NINJA = `rule C_COMPILER__probe
  command = sh ../compiler.sh $DEP_FILE
  depfile = $DEP_FILE
  deps = gcc

rule RERUN_CMAKE
  command = false
  generator = 1

`;

// Use real actions and Ninja. The compiler substitute writes a depfile,
// so these tests do not need a downloaded C compiler.
function scanFixture(mode) {
	let buildText = BUILD_NINJA;
	let rulesText = RULES_NINJA;
	const isMsvc = mode === "msvc headers" || mode === "msvc no headers";
	let compiler =
		'test "$2" = -fsyntax-only || exit 9; printf "obj: ../source.c ../used.h\\n" > "$1"';
	if (isMsvc) {
		rulesText = rulesText.replace("deps = gcc", "deps = msvc");
		compiler =
			'test "$2" = /Zs || exit 9; ' +
			(mode === "msvc headers"
				? 'printf "Note: including file: ../used.h\\n"'
				: "true");
	} else if (mode === "compiler failure") {
		compiler = "echo scan-compiler-failed >&2; exit 7";
	} else if (mode === "missing depfile") {
		compiler = "true";
	} else if (mode === "invalid graph") {
		buildText = "invalid ninja syntax\n";
	} else if (mode === "no targets") {
		buildText = "build obj: phony\n";
	} else if (mode === "patch failure") {
		rulesText = "";
	} else if (mode === "gcc no headers") {
		compiler = 'printf "obj: ../source.c\\n" > "$1"';
	} else if (mode === "omitted source") {
		compiler = 'printf "obj: ../used.h\\n" > "$1"';
	}
	const graph = parseNinja(BUILD_NINJA, () =>
		isMsvc ? rulesText : RULES_NINJA,
	);
	graph.sandboxRoot = "/oldroot";
	if (mode === "missing record") {
		const compilerEdge = graph.edges.find(
			(edge) => edge.rule === "C_COMPILER__probe",
		);
		graph.edges.push({ ...compilerEdge, outputs: ["unscanned"] });
	}
	const configured = task({
		inputs: { mkdir: nativeTool("mkdir") },
		outputs: {
			directory: output.artifact(),
			ninjaGraph: output.value(),
			sourcePaths: output.value(),
		},
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'set -eu; mkdir -p "$1/build/CMakeFiles"; ' +
						'printf "%s" "$2" > "$1/build/build.ninja"; ' +
						'if [ -n "$3" ]; then printf "%s" "$3" > "$1/build/CMakeFiles/rules.ninja"; fi; ' +
						'printf "%s" "$4" > "$1/compiler.sh"; ' +
						': > "$1/source.c"; : > "$1/used.h"; : > "$1/unused.h"',
					"scan-fixture",
					ROOT,
					buildText,
					rulesText,
					compiler,
				],
				tools: [input.mkdir],
				outputs: { directory: output.directory(ROOT) },
			});
			return {
				directory: result.outputs.directory,
				ninjaGraph: graph,
				sourcePaths: [SOURCE, HEADER, `${ROOT}/unused.h`],
			};
		},
	});
	return scanCmakeCompilerInputs(
		{
			path: ROOT,
			buildDirPath: BUILD_DIR,
			srcsInput: configured.outputs.directory,
			dirInputs: {},
			deps: [],
			toolchain: {
				kind: isMsvc ? "msvc-host-toolchain" : "gcc",
				taskInputs: () => ({ shell: nativeTool("sh") }),
				resolveState: (exec, input) => {
					exec.tool(input.shell, "sh");
					return null;
				},
				resolvesToolName: () => false,
				edgeEnv: () => [],
			},
		},
		configured,
	).outputs.manifest;
}

describe("compiler scan actions", () => {
	test("runs Ninja and removes the configure regeneration edge", async () => {
		const manifest = await resolveGraphHandle(scanFixture("success"));
		expect(manifest.obj.headers).toEqual([HEADER]);
	});
	test("accepts a GCC record with no headers", async () => {
		const manifest = await resolveGraphHandle(scanFixture("gcc no headers"));
		expect(manifest.obj.headers).toEqual([]);
	});
	test("accepts MSVC headers without a direct source in the record", async () => {
		const manifest = await resolveGraphHandle(scanFixture("msvc headers"));
		expect(manifest.obj.headers).toEqual([HEADER]);
	});
	test("accepts an MSVC record with no headers", async () => {
		const manifest = await resolveGraphHandle(scanFixture("msvc no headers"));
		expect(manifest.obj.headers).toEqual([]);
	});
	for (const mode of [
		"compiler failure",
		"missing depfile",
		"missing record",
		"invalid graph",
		"no targets",
		"patch failure",
		"omitted source",
	]) {
		test(`rejects ${mode}`, async () => {
			let failure;
			try {
				await resolveGraphHandle(scanFixture(mode));
			} catch (error) {
				failure = String(error.message || error);
			}
			if (failure === undefined) throw new Error(`scan accepted ${mode}`);
			if (mode === "missing record") {
				expect(
					failure.includes("Ninja did not report compiler dependencies"),
				).toBe(true);
			} else if (mode === "missing depfile" || mode === "omitted source") {
				expect(
					failure.includes("Ninja dependency record omitted the direct source"),
				).toBe(true);
			} else {
				if (!failure.includes("failed with exit code"))
					throw new Error(failure);
				if (mode === "compiler failure") {
					expect(failure.includes("scan-compiler-failed")).toBe(true);
				} else if (mode === "no targets") {
					expect(
						failure.includes("cmake dependency scan found no compiler targets"),
					).toBe(true);
				}
			}
		});
	}
});
