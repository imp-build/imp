import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetPythonSourceStateForTest,
	PythonSource,
	pythonProject,
	pythonSources,
	pythonToolchain,
	pythonSourceRun,
} from "//rules/python/source";
import {
	__resetUvToolchainStateForTest,
	uvToolchain,
} from "//rules/python/uv_toolchain";

function withPythonHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetPythonSourceStateForTest();
		__resetUvToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetPythonSourceStateForTest();
			__resetUvToolchainStateForTest();
		}
	});
}

describe("python sources", () => {
	test("requires an explicit root and rejects recursive source patterns", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });
			expect(() => pythonSources()).toThrow("workspace-relative root");
			expect(() =>
				pythonSources({ root: "rules/python", sources: ["**/*.py"] }),
			).toThrow("direct");
		});
	});

	test("runs an unprojected source through the pinned interpreter", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const runtime = pythonToolchain("3.13.0", { default: true });
			const source = new PythonSource({
				file: "rules/python/example/src/hello/__main__.py",
				root: "rules/python/example/src",
				sourceFiles: [
					"rules/python/example/src/hello/__init__.py",
					"rules/python/example/src/hello/__main__.py",
				],
				runtime,
			});

			const template = await pythonSourceRun(source);

			expect(template.opts.argv[2]).toContain(
				"uv run --no-project --managed-python",
			);
			expect(template.opts.argv).toContain("3.13.0");
			expect(template.opts.argv).toContain(
				"rules/python/example/src/hello/__main__.py",
			);
			expect(template.__impRunTemplate).toBe(true);
			expect(template.opts.impure).toBe(undefined);
		});
	});

	test("uses the default locked project without making it the source owner", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const runtime = pythonToolchain("3.13.0", { default: true });
			const project = pythonProject({
				path: "rules/python/example",
				default: true,
			});
			const source = new PythonSource({
				file: "rules/python/example/src/hello/__main__.py",
				root: "rules/python/example/src",
				sourceFiles: ["rules/python/example/src/hello/__main__.py"],
				runtime,
				project,
			});

			const template = await pythonSourceRun(source);

			expect(template.opts.argv[2]).toContain("uv sync --project");
			expect(template.opts.argv[2]).toContain("--no-install-project");
			expect(template.opts.argv).toContain("rules/python/example/.venv");
		});
	});
});
