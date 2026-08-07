import { describe, expect, test } from "//rules/imp/test";
import "//rules/odin/vscode";
import { odinPackage } from "//rules/odin";
import { VSCODE } from "//rules/workflows/vs";

describe("Odin graph vscode facet", () => {
	test("importing vscode attaches a construction-time vscode facet", {
		fixture: "workspace",
	}, () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg[VSCODE].__imp_graph_handle).toBe(true);
	});
});
