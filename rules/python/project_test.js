import { describe, expect, test } from "//rules/imp/test";
import {
	inferPythonProject,
	pythonProject,
	pythonWorkspaceRef,
} from "//rules/python/project";
import { pythonWorkspace } from "//rules/python/workspace";

describe("Python workspace and project declarations", () => {
	test("a workspace contains projects by workspace-relative path", () => {
		const workspace = pythonWorkspaceRef("rules/python/testdata/workspace");
		const project = pythonProject({
			workspace,
			path: "packages/app",
		});
		expect(project.path).toBe("rules/python/testdata/workspace/packages/app");
		expect(project.workspace.path).toBe("rules/python/testdata/workspace");
	});

	test("a project may refer to its workspace root", () => {
		const workspace = pythonWorkspaceRef("rules/python/example");
		const project = pythonProject({ workspace, path: "." });
		expect(project.path).toBe("rules/python/example");
	});

	test("a target path infers its nearest member and uv workspace", () => {
		const project = inferPythonProject(
			"rules/python/testdata/workspace/packages/app/src",
			"pythonApp",
		);
		expect(project.path).toBe("rules/python/testdata/workspace/packages/app");
		expect(project.workspace.path).toBe("rules/python/testdata/workspace");
	});

	test("a standalone pyproject is a one-project workspace", () => {
		const project = inferPythonProject(
			"rules/python/example/src/hello",
			"pythonApp",
		);
		expect(project.path).toBe("rules/python/example");
		expect(project.workspace.path).toBe("rules/python/example");
	});

	test("inference reports a missing project", () => {
		expect(() => inferPythonProject("rules/python", "pythonApp")).toThrow(
			"No pyproject.toml found",
		);
	});

	test("workspace and project declarations reject parent traversal", () => {
		expect(() => pythonWorkspaceRef("../python")).toThrow(
			"stay in the workspace",
		);
		const workspace = pythonWorkspaceRef("rules/python/example");
		expect(() => pythonProject({ workspace, path: "../other" })).toThrow(
			"stay in the workspace",
		);
	});

	test("workspace declarations expose their lock root", () => {
		const workspace = pythonWorkspace({ path: "rules/python/example" });
		expect(workspace.__python_workspace).toBe(true);
	});
});
