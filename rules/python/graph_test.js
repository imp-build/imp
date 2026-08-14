import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { pythonApp, pythonTest } from "//rules/python";
import { pexToolchain } from "//rules/python/pex_toolchain";
import { pythonResolve } from "//rules/python/resolve";
import { uvToolchain } from "//rules/python/uv_toolchain";
import "//rules/python/ruff/fmt";
import "//rules/python/ruff/lint";

describe("Python graph declarations", () => {
	test("application exports build, package, run, and Ruff roots", () => {
		const app = pythonApp({
			base: "rules/python/example",
			entryPoint: "hello.__main__",
		});
		expect(app.root).toBe("rules/python/example");
		for (const workflow of [BUILD, PACKAGE, RUN, FMT, LINT])
			expect(app[workflow].__imp_graph_handle).toBe(true);
	});

	test("application accepts an explicit pythonVersion override", () => {
		const app = pythonApp({
			base: "rules/python/example",
			entryPoint: "hello.__main__",
			pythonVersion: "3.12.4",
		});
		expect(app[RUN].__imp_graph_handle).toBe(true);
	});

	test("test roots carry their resolve and test options into a graph task", () => {
		const resolve = pythonResolve({
			path: "rules/python/example",
			flavors: { default: {}, cpu: { extra: "cpu" } },
		});
		const suite = pythonTest({ resolve, testArgs: ["-q"] });
		expect(suite.root).toBe("rules/python/example");
		expect(suite[TEST].__imp_graph_handle).toBe(true);
	});

	test("[RUN] describes its program for graphRunGoal to execute, rather than running it itself", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pexToolchain("2.97.1", { default: true, unverified: true });
			const app = pythonApp({
				base: "rules/python/example",
				entryPoint: "hello.__main__",
			});
			const description = await host.resolve(app[RUN]);
			expect(Array.isArray(description.argv)).toBe(true);
			expect(typeof description.digest).toBe("string");
			expect(description.tools.length).toBe(1);
			expect(description.tools[0].name).toBe("uv");
			// The RUN task itself must never call exec.action() — resolving it
			// records no run() calls beyond the build chain producing the digest.
			expect(
				host.runs.some((r) => r.display === "python run rules/python/example"),
			).toBe(false);
		});
	});

	test("[TEST] reports a failing file as ok:false with captured output instead of throwing", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const display = "python test rules/python/example";
			host.setRunStdout(
				display,
				"FAILED tests/test_hello.py::test_greets - AssertionError\n" +
					"PASSED tests/test_other.py::test_ok\n",
			);
			host.setRunExitCode(display, 1);
			const suite = pythonTest({
				resolve: pythonResolve({ path: "rules/python/example" }),
			});
			const units = await host.resolve(suite[TEST]);
			expect(units.length).toBe(2);
			const failed = units.find((u) => u.name === "tests/test_hello.py");
			const passed = units.find((u) => u.name === "tests/test_other.py");
			expect(failed.ok).toBe(false);
			expect(failed.output).toContain("AssertionError");
			expect(passed.ok).toBe(true);
		});
	});
});
