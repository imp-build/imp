import { describe, expect, test } from "//rules/imp/test";
import {
	odinArtifactName,
	odinCacheKey,
	odinGraphTool,
	odinToolchain,
} from "//rules/odin/toolchain";

describe("Odin graph toolchain", () => {
	test("formats release identity", () => {
		expect(
			odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe("odin-linux-amd64-dev-2026-03.tar.gz");
		expect(odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" })).toBe(
			"dev-2026-03/linux-x86_64",
		);
	});

	test("declares verified graph tools", () => {
		expect(
			odinToolchain("dev-2026-03", { default: true }).__imp_graph_handle,
		).toBe(true);
		expect(odinGraphTool("dev-2026-03").__imp_graph_handle).toBe(true);
	});
});
