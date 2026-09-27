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
import { defaultPythonRuntimeVersion } from "//rules/python/runtime";
import { uvToolchain } from "//rules/python/uv_toolchain";
import {
	__resetRuffToolchainStateForTest,
	ruffToolchain,
} from "//rules/python/ruff_toolchain";
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

	test("pins application build and run to the same Python version", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pexToolchain("2.97.1", { default: true, unverified: true });
			const app = pythonApp({
				base: "rules/python/example",
				entryPoint: "hello.__main__",
				pythonVersion: "3.12.4",
			});

			await host.resolve(app[BUILD]);
			const buildRun = host.runs.find(
				(run) => run.display === "python-app build rules/python/example",
			);
			expect(buildRun.argv[2]).toContain(
				'--locked --no-dev --no-progress --managed-python --python "$version"',
			);
			expect(buildRun.argv).toContain("3.12.4");

			const description = await host.resolve(app[RUN]);
			expect(description.argv).toContain("3.12.4");
		});
	});

	test("a root-level application gives PEX only its declared sources", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pexToolchain("2.97.1", { default: true, unverified: true });
			const app = pythonApp({
				base: ".",
				entryPoint: "hello.__main__",
				sources: ["rules/python/example/src/**/*.py"],
			});

			await host.resolve(app[BUILD]);
			const buildRun = host.runs.find(
				(run) => run.display === "python-app build .",
			);
			expect(buildRun.argv[2]).toContain('-D "$stage"');
			expect(buildRun.argv[2]).not.toContain('-D "$src"');
			const stageIndex = buildRun.argv.indexOf(".imp-pex-sources");
			// sh, -c, the script and $0 come first, so ${10} is at index 13.
			expect(stageIndex).toBe(13);
			expect(buildRun.argv.slice(stageIndex + 1).sort()).toEqual([
				"rules/python/example/src/hello/__init__.py",
				"rules/python/example/src/hello/__main__.py",
			]);
		});
	});

	test("a nested application stages sources relative to the project", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pexToolchain("2.97.1", { default: true, unverified: true });
			const app = pythonApp({
				base: "rules/python/example",
				entryPoint: "hello.__main__",
				sources: ["src/**/*.py"],
			});

			await host.resolve(app[BUILD]);
			const buildRun = host.runs.find(
				(run) => run.display === "python-app build rules/python/example",
			);
			const stageIndex = buildRun.argv.indexOf(".imp-pex-sources");
			expect(buildRun.argv.slice(stageIndex + 1).sort()).toEqual([
				"src/hello/__init__.py",
				"src/hello/__main__.py",
			]);
		});
	});

	test("Ruff fmt and lint stage the app config files that apply to the sources", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				ruffToolchain("0.15.20", { default: true, unverified: true });
				const fixture = "rules/python/testdata/ruff_config";
				const app = pythonApp({
					base: `${fixture}/app`,
					entryPoint: "pkg.mod",
					sources: ["src/**/*.py"],
				});
				await host.resolve(app[FMT]);
				await host.resolve(app[LINT]);
				const fmtRun = host.runs.find(
					(run) => run.display === `ruff fmt ${fixture}/app`,
				);
				const lintRun = host.runs.find(
					(run) => run.display === `ruff lint ${fixture}/app`,
				);
				// lint copies the configs into fixed/ and then drops them, so
				// Ruff checks only the sources.
				const count = Number(lintRun.argv[6]);
				const configs = lintRun.argv.slice(7, 7 + count);
				expect(
					configs.filter((path) => path.startsWith(`${fixture}/`)).sort(),
				).toEqual([
					`${fixture}/app/pyproject.toml`,
					`${fixture}/app/src/pkg/.ruff.toml`,
					`${fixture}/ruff.toml`,
				]);
				expect(lintRun.argv.slice(7 + count)).toEqual([
					`${fixture}/app/src/pkg/mod.py`,
				]);
				expect(lintRun.argv[2]).toContain("--no-cache");
				// fmt runs Ruff in place, so it stages the same configs but
				// does not name them in its argv.
				expect(fmtRun.inputs).toEqual(lintRun.inputs);
				expect(fmtRun.argv.slice(6)).toEqual([`${fixture}/app/src/pkg/mod.py`]);
				expect(fmtRun.argv[2]).toContain("--no-cache");
			} finally {
				__resetRuffToolchainStateForTest();
			}
		});
	});

	test("Ruff fmt and lint attach to pythonTest sources", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				ruffToolchain("0.15.20", { default: true, unverified: true });
				const fixture = "rules/python/testdata/ruff_config";
				const suite = pythonTest({
					base: `${fixture}/app`,
					sources: ["tests/*.py"],
				});
				await host.resolve(suite[FMT]);
				await host.resolve(suite[LINT]);
				const fmtRun = host.runs.find(
					(run) => run.display === `ruff fmt ${fixture}/app`,
				);
				const lintRun = host.runs.find(
					(run) => run.display === `ruff lint ${fixture}/app`,
				);
				const count = Number(lintRun.argv[6]);
				const configs = lintRun.argv.slice(7, 7 + count);
				expect(
					configs.filter((path) => path.startsWith(`${fixture}/`)).sort(),
				).toEqual([
					`${fixture}/app/pyproject.toml`,
					`${fixture}/app/tests/ruff.toml`,
					`${fixture}/ruff.toml`,
				]);
				expect(lintRun.argv.slice(7 + count)).toEqual([
					`${fixture}/app/tests/test_mod.py`,
				]);
				expect(fmtRun.argv.slice(6)).toEqual([
					`${fixture}/app/tests/test_mod.py`,
				]);
			} finally {
				__resetRuffToolchainStateForTest();
			}
		});
	});

	test("Ruff lint accepts the default root-level source pattern", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				ruffToolchain("0.15.20", { default: true, unverified: true });
				const app = pythonApp({
					base: "rules/python/testdata/ruff_config/app",
					entryPoint: "pkg.mod",
				});
				const result = await host.resolve(app[LINT]);
				expect(result.ok).toBe(true);
			} finally {
				__resetRuffToolchainStateForTest();
			}
		});
	});

	test("Ruff lint stages no fixture config for a project outside the fixture", async () => {
		await withFakeToolchainHost(async (host) => {
			try {
				ruffToolchain("0.15.20", { default: true, unverified: true });
				const app = pythonApp({
					base: "rules/python",
					entryPoint: "hello.__main__",
					sources: ["example/src/**/*.py"],
				});
				await host.resolve(app[LINT]);
				const lintRun = host.runs.find(
					(run) => run.display === "ruff lint rules/python",
				);
				const count = Number(lintRun.argv[6]);
				expect(
					lintRun.argv
						.slice(7, 7 + count)
						.filter((path) => path.startsWith("rules/")),
				).toEqual([]);
				expect(lintRun.argv.slice(7 + count)).toEqual([
					"rules/python/example/src/hello/__init__.py",
					"rules/python/example/src/hello/__main__.py",
				]);
			} finally {
				__resetRuffToolchainStateForTest();
			}
		});
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

	test("pins test sync to the Python version the application uses", async () => {
		await withFakeToolchainHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const display = "python test rules/python/example";
			const pinned = pythonTest({
				base: "rules/python/example",
				pythonVersion: "3.12.4",
			});
			await host.resolve(pinned[TEST]);
			const pinnedRun = host.runs.find((run) => run.display === display);
			expect(pinnedRun.argv[2]).toContain(
				'--managed-python --python "$version"',
			);
			expect(pinnedRun.argv[8]).toBe("3.12.4");

			const suite = pythonTest({ base: "rules/python/example" });
			await host.resolve(suite[TEST]);
			const defaultRun = host.runs.findLast((run) => run.display === display);
			expect(defaultRun.argv[8]).toBe(defaultPythonRuntimeVersion());
		});
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
