import { RUN } from "//rules/workflows/run";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { pythonRuntime } from "//rules/python/runtime";
import { pythonProject } from "//rules/python/project";
import { pythonSourceRunSpec, pythonSources } from "//rules/python/source";
import { pythonWorkspace } from "//rules/python/workspace";
import {
	__resetUvToolchainStateForTest,
	uvToolchain,
} from "//rules/python/uv_toolchain";

function withPythonHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetUvToolchainStateForTest();
		pythonRuntime("3.13.0");
		try {
			return await fn(host);
		} finally {
			pythonRuntime("3.13.0");
			__resetUvToolchainStateForTest();
		}
	});
}

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
			expect(() => pythonSources()).toThrow("workspace-relative root");
			expect(() =>
				pythonSources({ root: "rules/python", sources: ["**/*.py"] }),
			).toThrow("direct");
		});
	});

	test("exports one expandable RUN root rather than a label per file", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });

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
			pythonRuntime("3.12.4");

			const described = await pythonSourceRunSpec(
				{
					file: "tools/demo.py",
					root: "tools",
					pythonVersion: "3.12.4",
					uvVersion: "0.11.16",
				},
				fakeUvTool,
			);

			expect(described.argv[2]).toContain(
				"uv run --no-project --managed-python",
			);
			expect(described.argv).toContain("3.12.4");
			expect(described.argv).toContain("tools/demo.py");
		});
	});

	test("pythonSources uses the shared pythonRuntime default", async () => {
		await withPythonHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonRuntime("3.12.4");
			const scripts = pythonSources({
				root: "rules/python/example/src/hello",
			});
			const described = await host.resolve(scripts[RUN]);
			expect(JSON.stringify(described)).toContain("3.12.4");
		});
	});

	test("infers the containing workspace for source runs", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });

			const scripts = pythonSources({
				root: "rules/python/testdata/workspace/packages/app/src",
			});
			expect(scripts[RUN].__imp_graph_handle).toBe(true);

			const project = pythonProject({
				workspace: pythonWorkspace({ path: "rules/python/testdata/workspace" }),
				path: "packages/app",
			});
			const described = await pythonSourceRunSpec(
				{
					file: "rules/python/testdata/workspace/packages/app/src/app.py",
					root: "rules/python/testdata/workspace/packages/app/src",
					project,
					pythonVersion: "3.13.0",
					uvVersion: "0.11.16",
				},
				fakeUvTool,
			);
			expect(described.argv[2]).toContain(
				'--project "$workspace" --all-packages',
			);
			expect(described.argv).toContain("rules/python/testdata/workspace/.venv");
		});
	});

	test("rejects project handles without a workspace", async () => {
		await withPythonHost(async () => {
			expect(() => pythonProject({ path: "rules/python/example" })).toThrow(
				"pythonWorkspace",
			);
		});
	});
});
