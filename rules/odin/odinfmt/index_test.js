import { FMT } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import "//rules/odin/odinfmt";
import { odinPackage } from "//rules/odin";

describe("Odin graph formatter", () => {
	test("importing odinfmt attaches a construction-time fmt facet", () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg[FMT].__imp_graph_handle).toBe(true);
	});
});
