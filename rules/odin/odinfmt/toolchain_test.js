import { describe, expect, test } from "//rules/imp/test";
import {
	odinfmtArtifactName,
	odinfmtGraphTool,
	odinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";

describe("odinfmt graph toolchain", () => {
	test("declares verified graph tools", () => {
		expect(
			odinfmtArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toContain("ols-x86_64-unknown-linux-gnu.zip");
		expect(odinfmtToolchain("dev-2026-03").__imp_graph_handle).toBe(true);
		expect(odinfmtGraphTool("dev-2026-03").__imp_graph_handle).toBe(true);
	});
});
