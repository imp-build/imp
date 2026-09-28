import { RUN } from "//rules/workflows/run";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { pythonProject } from "//rules/python/project";
import {
	__resetPythonSourceStateForTest,
	pythonSourceRunSpec,
	pythonSources,
	pythonToolchain,
} from "//rules/python/source";
import { pythonWorkspace } from "//rules/python/workspace";
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
					file: "tools/demo.py",
					root: "tools",
					pythonVersion: runtime.attrs.version,
					uvVersion: "0.11.16",
				},
				fakeUvTool,
			);

			expect(described.argv[2]).toContain(
				"uv run --no-project --managed-python",
			);
			expect(described.argv).toContain("3.13.0");
			expect(described.argv).toContain("tools/demo.py");
		});
	});

	test("infers the containing workspace for source runs", async () => {
		await withPythonHost(async () => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			pythonToolchain("3.13.0", { default: true });

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
