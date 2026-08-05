import { BUILD } from "imp:core";
import { asset, resourcePackage } from "//rules/asset";
import { expect, test } from "//rules/imp/test";

test("asset returns source and build graph handles", () => {
	const ui = asset({ srcs: ["rules/asset/*.js"] });
	expect(ui.sources.__imp_graph_handle).toBe(true);
	expect(ui[BUILD].__imp_graph_handle).toBe(true);
});

test("resourcePackage retains its legacy carrier and exposes graph files", () => {
	const resources = resourcePackage({ srcs: ["rules/asset/*.js"] });
	expect(resources.__imp).toBe(true);
	expect(resources.files.__imp_graph_handle).toBe(true);
});

test("resourcePackage rejects paths outside the workspace", () => {
	expect(() => resourcePackage({ srcs: ["*.txt"], path: "../outside" })).toThrow(
		"must stay within the workspace",
	);
});

test("asset accepts an explicit source base", () => {
	const ui = asset({ base: ".", srcs: ["rules/asset/*.js"] });
	expect(ui.sources.__imp_graph_handle).toBe(true);
});
