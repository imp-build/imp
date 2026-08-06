import { BUILD, LINT, PACKAGE, RUN, TEST } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { odinGen, odinPackage, odinTestPackage } from "//rules/odin";

describe("Odin graph rules", () => {
	test("packages expose immutable graph roots", () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg.sources.__imp_graph_handle).toBe(true);
		expect(pkg[BUILD].__imp_graph_handle).toBe(true);
		expect(pkg[LINT].__imp_graph_handle).toBe(true);
		expect(pkg[PACKAGE].__imp_graph_handle).toBe(true);
		expect(pkg[RUN].__imp_graph_handle).toBe(true);
	});

	test("test packages expose only test-oriented actions", () => {
		const pkg = odinTestPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg[TEST].__imp_graph_handle).toBe(true);
		expect(pkg[RUN]).toBe(undefined);
	});

	test("generators produce a CAS artifact graph", () => {
		const generated = odinGen({
			srcs: ["*.json"],
			out: "generated/bindings.odin",
			cmd: ["echo"],
		});
		expect(generated.generated.__imp_graph_handle).toBe(true);
		expect(generated[BUILD].__imp_graph_handle).toBe(true);
	});
});
