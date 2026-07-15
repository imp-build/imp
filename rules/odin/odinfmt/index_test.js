import {
	describe,
	expect,
	test,
	withFakeRun,
	withFakeDiff,
} from "//rules/imp/test";
import { odinFmt, odinFormatCheck } from "//rules/odin/odinfmt";
import { odinPackage } from "//rules/odin";
import { getMemoTrace } from "imp:core";

const MAIN_ODIN = "rules/odin/example/main.odin";

describe("Odin fmt mechanics", () => {
	test("odinFmt runs odinfmt -w over the package's own sources, declares them as materialized outputs, no changes", async () => {
		await withFakeRun(async () => {
			// __host_diff_digests is stubbed (not the real digest comparison —
			// withFakeRun doesn't actually run odinfmt, so there's no real
			// "after" digest to diff) to exercise the "nothing changed" branch.
			await withFakeDiff([], async () => {
				const pkg = odinPackage({
					path: "rules/odin/example",
					srcs: ["**/*.odin"],
					toolchain: "dev-2026-04",
				});
				const result = await odinFmt(pkg);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display.startsWith("odinfmt "),
				);
				expect(runEffect.argv[2]).toContain("-w");
				expect(runEffect.outputs).toEqual([{ kind: "file", path: MAIN_ODIN }]);
				expect(runEffect.materialize).toBe(true);
				expect(result).toEqual({ formatted: 0 });
			});
		});
	});

	test("odinFmt reports every file the digest diff flags as changed", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([{ type: "modified", path: MAIN_ODIN }], async () => {
				const pkg = odinPackage({
					path: "rules/odin/example",
					srcs: ["**/*.odin"],
					toolchain: "dev-2026-04",
				});
				const result = await odinFmt(pkg);
				expect(result).toEqual({ formatted: 1 });
			});
		});
	});

	test("odinFormatCheck runs the same batched -w invocation without materializing, no changes", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([], async () => {
				const pkg = odinPackage({
					path: "rules/odin/example",
					srcs: ["**/*.odin"],
					toolchain: "dev-2026-04",
				});
				const result = await odinFormatCheck(pkg);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display.startsWith("odinfmt --check"),
				);
				expect(runEffect.outputs).toEqual([{ kind: "file", path: MAIN_ODIN }]);
				expect(runEffect.materialize).toBe(false);
				expect(result).toEqual({ checked: 1, unformatted: [] });
			});
		});
	});

	test("odinFormatCheck reports unformatted files without throwing", async () => {
		await withFakeRun(async () => {
			await withFakeDiff([{ type: "modified", path: MAIN_ODIN }], async () => {
				const pkg = odinPackage({
					path: "rules/odin/example",
					srcs: ["**/*.odin"],
					toolchain: "dev-2026-04",
				});
				const result = await odinFormatCheck(pkg);
				expect(result).toEqual({ checked: 1, unformatted: [MAIN_ODIN] });
			});
		});
	});

	test("odinFmt returns formatted: 0 without invoking run when there are no sources", async () => {
		await withFakeRun(async () => {
			const pkg = odinPackage({
				path: "rules/odin/example",
				srcs: ["missing*.odin"],
				toolchain: "dev-2026-04",
			});
			const result = await odinFmt(pkg);
			const { trace } = getMemoTrace();
			expect(trace.some((t) => t.event === "effect" && t.kind === "run")).toBe(
				false,
			);
			expect(result).toEqual({ formatted: 0 });
		});
	});

	test("odinFormatCheck returns checked: 0 without invoking run when there are no sources", async () => {
		await withFakeRun(async () => {
			const pkg = odinPackage({
				path: "rules/odin/example",
				srcs: ["missing*.odin"],
				toolchain: "dev-2026-04",
			});
			const result = await odinFormatCheck(pkg);
			const { trace } = getMemoTrace();
			expect(trace.some((t) => t.event === "effect" && t.kind === "run")).toBe(
				false,
			);
			expect(result).toEqual({ checked: 0, unformatted: [] });
		});
	});
});
