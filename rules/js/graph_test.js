import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
import { RUN } from "//rules/workflows/run";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { jsApp, tsApp } from "//rules/js";
import {
	__resetNodeToolchainStateForTest,
	nodeToolchain,
} from "//rules/js/node/toolchain";
import {
	__resetPnpmToolchainStateForTest,
	pnpmToolchain,
} from "//rules/js/pnpm/toolchain";
import "//rules/js/biome";
import "//rules/js/biome/lint";

describe("JS/TS app graph declarations", () => {
	test("jsApp exports build, run, and Biome roots", () => {
		const app = jsApp({
			base: "rules/js/example",
			src: "app",
			entry: "src/index.js",
		});
		expect(app.root).toBe("rules/js/example/app");
		for (const workflow of [BUILD, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
	});

	test("tsApp exports build, run, and Biome roots", () => {
		const app = tsApp({
			base: "rules/js/example",
			src: "app_ts",
			entry: "index.js",
		});
		expect(app.root).toBe("rules/js/example/app_ts");
		for (const workflow of [BUILD, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
	});

	test("[RUN] describes its program for graphRunGoal to execute, rather than running it itself", async () => {
		await withFakeToolchainHost(async (host) => {
			__resetNodeToolchainStateForTest();
			__resetPnpmToolchainStateForTest();
			try {
				nodeToolchain("22.11.0", { default: true, unverified: true });
				pnpmToolchain("11.13.0", { default: true, unverified: true });
				const app = jsApp({
					base: "rules/js/example",
					src: "app",
					entry: "src/index.js",
				});
				// The fake host's node_modules/dist digests are synthetic
				// (`digest:${path}`), not real CAS trees, so mergeDigests() —
				// which reads real digest trees — can't succeed here; same
				// limitation rules/c/cmake/expansion_test.js's own
				// resolveIgnoringArtifactValidation() documents. What this test
				// can still prove under this harness: resolving [RUN] never
				// records a "js run ..." exec call, confirming appRun() no
				// longer executes the program itself.
				try {
					await host.resolve(app[RUN]);
				} catch (error) {
					if (!String(error.message || error).includes("read digest node")) {
						throw error;
					}
				}
				expect(
					host.runs.some((r) => r.display === "js run rules/js/example/app"),
				).toBe(false);
			} finally {
				__resetNodeToolchainStateForTest();
				__resetPnpmToolchainStateForTest();
			}
		});
	});
});
