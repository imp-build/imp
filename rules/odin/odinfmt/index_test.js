import { FMT } from "//rules/workflows/fmt";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import "//rules/odin/odinfmt";
import { odinPackage } from "//rules/odin";
import {
	__resetOdinfmtToolchainStateForTest,
	odinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";

describe("Odin graph formatter", () => {
	test("importing odinfmt attaches a construction-time fmt facet", () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg[FMT].__imp_graph_handle).toBe(true);
	});

	test("passes -config when the workspace has an odinfmt.json", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				odinfmtToolchain("dev-2026-03", { default: true, unverified: true });
				host.addFile("//odinfmt.json", '{"newline_style":"LF"}');
				const pkg = odinPackage({
					path: "rules/odin/example",
					toolchain: "dev-2026-03",
				});
				await host.resolve(pkg[FMT]);
				const formatRun = host.runs.find((r) => r.argv?.[3] === "odinfmt");
				expect(formatRun).toBeTruthy();
				expect(formatRun.argv[5]).toBe("odinfmt.json");
			} finally {
				__resetOdinfmtToolchainStateForTest();
			}
		});
	});

	test("omits -config when the workspace has no odinfmt.json", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				odinfmtToolchain("dev-2026-03", { default: true, unverified: true });
				const pkg = odinPackage({
					path: "rules/odin/example",
					toolchain: "dev-2026-03",
				});
				await host.resolve(pkg[FMT]);
				const formatRun = host.runs.find((r) => r.argv?.[3] === "odinfmt");
				expect(formatRun).toBeTruthy();
				expect(formatRun.argv[5]).toBe("");
			} finally {
				__resetOdinfmtToolchainStateForTest();
			}
		});
	});
});
