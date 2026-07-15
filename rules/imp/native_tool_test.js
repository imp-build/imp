import { describe, expect, test } from "//rules/imp/test";
import { run, getMemoTrace } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

export const sh_tool = nativeTool("sh");
const missing_tool = nativeTool("__imp_no_such_binary_xyz");

describe("nativeTool", () => {
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
