import { CODEGEN, codegen } from "//rules/imp/codegen";
import { BUILD } from "//rules/workflows/build";
import { describe, expect, test } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";
import { nativeToolSpec } from "//rules/imp/native-tool";
import { output, run } from "imp:core";

const SH = nativeTool("sh");

function shCodegen(outputPaths, script = "true") {
	return codegen({
		tools: { sh: SH },
		outputPaths,
		argv: (exec, { sh }) => [exec.tool(sh, "sh"), "-c", script],
	});
}

describe("codegen", () => {
	test("exposes one artifact handle per output path, at construction", () => {
		const generated = shCodegen(["a/one.txt", "b/nested/two.txt"]);
		expect(generated.paths).toEqual(["a/one.txt", "b/nested/two.txt"]);
		expect(generated.files["a/one.txt"].__imp_graph_handle).toBe(true);
		expect(generated.files["b/nested/two.txt"].__imp_graph_handle).toBe(true);
		expect(generated[CODEGEN]).toBe(true);
		expect(generated[BUILD].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(generated)).toBe(true);
		expect(Object.isFrozen(generated.files)).toBe(true);
	});

	test("names the action after its outputs when no display is given", async () => {
		const generated = shCodegen(["a/one.txt"]);
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([
				{ address: "gen", handleId: generated[BUILD].__graph_id },
			]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({}),
		);
		const { nodes } = JSON.parse(walkJson);
		expect(nodes.some((node) => node.display === "generate a/one.txt")).toBe(
			true,
		);
	});

	test("rejects an empty or missing outputPaths", () => {
		expect(() => shCodegen([])).toThrow("non-empty outputPaths array");
		expect(() => codegen({ argv: () => [] })).toThrow(
			"non-empty outputPaths array",
		);
	});

	test("rejects an argv that is not a function", () => {
		expect(() => codegen({ outputPaths: ["a.txt"], argv: ["echo"] })).toThrow(
			"argv(exec, inputs) function",
		);
	});

	test("rejects one name used for both a tool and an input", () => {
		expect(() =>
			codegen({
				tools: { sh: SH },
				inputs: { sh: SH },
				outputPaths: ["a.txt"],
				argv: () => [],
			}),
		).toThrow("same name in tools and inputs");
	});

	test("rejects the reserved input name", () => {
		expect(() =>
			codegen({
				inputs: { outputPaths: SH },
				outputPaths: ["a.txt"],
				argv: () => [],
			}),
		).toThrow("reserves the input name");
	});

	test("rejects one output path declared twice", () => {
		expect(() => shCodegen(["a.txt", "a.txt"])).toThrow(
			"declares the output path 'a.txt' twice",
		);
	});

	// The action a codegen() declares must run with only the tools it declares.
	// //rules/odin's old odinGen shelled `mkdir -p "$(dirname ...)"` while
	// declaring nothing but `sh`, so every generator-mode target died with
	// `exit 127: mkdir: not found`. `env: ["PATH="]` reproduces that hermetic
	// condition: an empty base PATH, so only declared tools resolve. Without
	// it this suite's own sandbox would supply the missing binaries and the
	// test would pass while proving nothing.
	test("writes a nested output path with no tool beyond its declared shell", async () => {
		const sh = await nativeToolSpec(SH);
		const path = "rules/imp/.fake_scratch/nested/deep/value.txt";
		const result = await run({
			argv: ["sh", "-c", 'printf %s "hermetic" > "$1"', "codegen", path],
			tools: [sh],
			env: ["PATH="],
			outputs: [output.file(path)],
			materialize: false,
			allowFailure: true,
			display: "codegen nested output",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});
});
