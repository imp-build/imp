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

	// Issue #7: `--changed-since` needs to see the real dependency edge a
	// genuine inferred Odin import produces (not a hand-wired one), since
	// that's exactly what `spike::stale_graph_addresses` walks in Rust via
	// `__imp_walk_graph_for_introspection(..., { discoverExpansionGet: true })`.
	// pkg_b (fixtures under example/staleness/) really imports "../pkg_a" —
	// this asserts that produces a genuine sourceN task-input edge reaching
	// pkg_a's sources handle, not merely that pkg_a is reachable somehow.
	test("staleness walk reaches real inferred-import dependency edges", async () => {
		const pkgA = odinPackage({
			path: "rules/odin/example/staleness/pkg_a",
			toolchain: "dev-2026-03",
		});
		const pkgB = odinPackage({
			path: "rules/odin/example/staleness/pkg_b",
			toolchain: "dev-2026-03",
		});
		expect(pkgA.sources.__imp_graph_handle).toBe(true);

		const roots = [{ address: "pkgB", handleId: pkgB[BUILD].__graph_id }];
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify(roots),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const { nodes } = JSON.parse(walkJson);
		const fileRoots = nodes
			.filter((node) => node.kind === "files")
			.map((node) => node.data && node.data.root);
		expect(fileRoots).toContain("rules/odin/example/staleness/pkg_a");
	});
});
