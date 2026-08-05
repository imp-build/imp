import { describe, expect, test } from "//rules/imp/test";
import { Target, getMemoTrace, product, run, toolName } from "imp:core";
import {
	TOOL,
	nativeTool,
	nativeToolSpec,
	toolSpec,
} from "//rules/imp/native-tool";

const LEGACY_TOOL = toolName("native-tool-test-legacy");
class LegacyToolProvider extends Target {
	static kind = "native-tool-test-legacy";
	constructor() {
		super({ kind: LegacyToolProvider.kind, attrs: {} });
	}
}
product(LegacyToolProvider, TOOL, LEGACY_TOOL, async function legacyToolSpec() {
	return { name: "legacy", path: "/legacy", binDirs: ["."] };
});

export const sh_tool = nativeTool("sh");
const missing_tool = nativeTool("__imp_no_such_binary_xyz");

describe("nativeTool", () => {
	test("constructs an immutable graph tool handle, not a target", () => {
		expect(Object.isFrozen(sh_tool)).toBe(true);
		expect(sh_tool.__imp).toBe(undefined);
		expect(sh_tool.__imp_graph_handle).toBe(true);
		expect(sh_tool.__imp_native_tool).toBe("native-tool");
		expect(sh_tool.name).toBe("sh");
	});

	test("resolves a PATH executable into a tool descriptor", async () => {
		const spec = await nativeToolSpec(sh_tool);
		expect(spec.name).toBe("sh");
		expect(spec.binDirs).toEqual(["."]);
		expect(typeof spec.path).toBe("string");
	});

	test("rejects for a binary that isn't on PATH", async () => {
		let thrown = null;
		try {
			await nativeToolSpec(missing_tool);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain("__imp_no_such_binary_xyz");
		expect(thrown.message).toContain("PATH");
	});

	test("resolving twice only performs one underlying lookup", async () => {
		await nativeToolSpec(sh_tool);
		await nativeToolSpec(sh_tool);
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) =>
				t.event === "effect" &&
				t.kind === "nativeToolArtifact" &&
				t.name === "sh",
		);
		expect(effects.length).toBe(1);
		expect(trace.some((event) => event.event === "memo-unaddressed-skip")).toBe(
			false,
		);
	});

	test("toolSpec resolves native specs and retained target providers", async () => {
		expect((await toolSpec(sh_tool)).name).toBe("sh");
		expect((await toolSpec(new LegacyToolProvider())).name).toBe("legacy");
	});

	test("the resolved tool is reachable via PATH even with an empty base PATH", async () => {
		const spec = await nativeToolSpec(sh_tool);
		const result = await run({
			argv: ["sh", "-c", "echo hi"],
			tools: [spec],
			env: ["PATH="],
			display: "nativeTool smoke test",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hi");
	});
});
