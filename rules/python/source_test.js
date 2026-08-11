import { RUN } from "//rules/workflows/run";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetPythonSourceStateForTest,
	pythonProject,
	pythonSourceRunSpec,
	pythonSources,
	pythonToolchain,
} from "//rules/python/source";
import { pythonResolve } from "//rules/python/resolve";
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

// pythonSourceRunSpec() takes the uv tool resolver as its second parameter so
// the description can be asserted without acquiring a real toolchain.
const fakeUvTool = async (version) => ({
	kind: "tool",
	name: "uv-toolchain",
	key: version,
	binDirs: ["."],
});

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

	test("rejects declaring both a project and a resolve", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });
			const resolve = pythonResolve({ path: "rules/python/example" });
			expect(() =>
				pythonSources({
					root: "rules/python/example/src",
					project: resolve,
					resolve,
				}),
			).toThrow("either project or resolve");
		});
	});

	test("exports one expandable RUN root rather than a label per file", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });

			const scripts = pythonSources({
				root: "rules/python/example/src/hello",
				sources: ["*.py"],
			});

			expect(scripts.root).toBe("rules/python/example/src/hello");
			expect(scripts[RUN].__imp_graph_handle).toBe(true);
		});
	});

	test("runs an unprojected source through the pinned interpreter", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const runtime = pythonToolchain("3.13.0", { default: true });

			const described = await pythonSourceRunSpec(
				{
					file: "rules/python/example/src/hello/__main__.py",
					root: "rules/python/example/src",
					pythonVersion: runtime.attrs.version,
					uvVersion: "0.11.16",
				},
				fakeUvTool,
			);

			expect(described.argv[2]).toContain(
				"uv run --no-project --managed-python",
			);
			expect(described.argv).toContain("3.13.0");
			expect(described.argv).toContain(
				"rules/python/example/src/hello/__main__.py",
			);
			expect(described.display).toBe(
				"python run rules/python/example/src/hello/__main__.py",
			);
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

			const described = await pythonSourceRunSpec(
				{
					file: "rules/python/example/src/hello/__main__.py",
					root: "rules/python/example/src",
					resolve: project,
					pythonVersion: runtime.attrs.version,
					uvVersion: "0.11.16",
				},
				fakeUvTool,
			);

			expect(described.argv[2]).toContain("uv sync --project");
			expect(described.argv[2]).toContain("--no-install-project");
			expect(described.argv).toContain("rules/python/example/.venv");
		});
	});

	test("selects a resolve flavor from the explicitly supplied mode", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });
			const resolve = pythonResolve({
				path: "rules/python/example",
				flavors: { default: {}, cpu: { extra: "cpu" } },
			});

			const described = await pythonSourceRunSpec(
				{
					file: "tools/demo.py",
					root: "tools",
					resolve,
					pythonVersion: "3.13.0",
					uvVersion: "0.11.16",
					mode: "cpu",
				},
				fakeUvTool,
			);

			expect(described.argv[2]).toContain("--extra");
			expect(described.argv[2]).toContain("cpu");
		});
	});

	test("attaches an explicit resolve to a source set", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });
			const resolve = pythonResolve({
				path: "rules/python/example",
				flavors: { default: { extra: "cpu" } },
			});

			const scripts = pythonSources({
				root: "rules/python/example/src",
				sources: ["*.py"],
				resolve,
			});

			expect(scripts[RUN].__imp_graph_handle).toBe(true);
		});
	});
});
