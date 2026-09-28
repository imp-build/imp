import { files, packagePath, read_file } from "imp:core";

function normalize_path(path, message) {
	if (typeof path !== "string" || path === "") {
		throw new Error(message);
	}
	const parts = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..")
			throw new Error(`Python paths must stay in the workspace: ${path}`);
		parts.push(part);
	}
	return parts.join("/") || ".";
}

export function pythonWorkspaceRef(path) {
	return Object.freeze({
		__python_workspace: true,
		path: normalize_path(
			path,
			"pythonWorkspace({ path }) requires a workspace-relative path",
		),
	});
}

/**
 * Declare a project that is a member of one uv workspace.
 *
 * @category configuration
 * @param {object} opts Project location and its uv workspace.
 * @param {object} opts.workspace Handle returned by pythonWorkspace().
 * @param {string} [opts.path] Workspace-relative directory with pyproject.toml.
 * @returns {object} A frozen Python project handle.
 */
export function pythonProject({ workspace, path } = {}) {
	if (!workspace || workspace.__python_workspace !== true) {
		throw new Error(
			"pythonProject({ workspace }) expects pythonWorkspace(...)",
		);
	}
	const projectPath = normalize_path(
		path ?? packagePath(),
		"pythonProject({ path }) requires a workspace-relative path",
	);
	const fullPath =
		projectPath === "."
			? workspace.path
			: workspace.path === "."
				? projectPath
				: projectPath === workspace.path ||
						projectPath.startsWith(`${workspace.path}/`)
					? projectPath
					: `${workspace.path}/${projectPath}`;
	return Object.freeze({
		__python_project: true,
		path: fullPath,
		workspace: pythonWorkspaceRef(workspace.path),
	});
}

function ancestors(path) {
	const result = [];
	let current = normalize_path(
		path,
		"Python target path must be workspace-relative",
	);
	while (true) {
		result.push(current);
		if (current === ".") break;
		const slash = current.lastIndexOf("/");
		current = slash === -1 ? "." : current.slice(0, slash) || ".";
	}
	return result;
}

function has_pyproject(path) {
	try {
		read_file(path === "." ? "pyproject.toml" : `${path}/pyproject.toml`);
		return true;
	} catch {
		return false;
	}
}

function is_uv_workspace(path) {
	const file = path === "." ? "pyproject.toml" : `${path}/pyproject.toml`;
	const source = read_file(file);
	return /^\s*\[tool\.uv\.workspace\]\s*(?:#.*)?$/m.test(source);
}

/** Find the nearest project and its nearest enclosing uv workspace. */
export function findPythonProject(path) {
	const projectPath = ancestors(path).find(has_pyproject);
	if (!projectPath) return null;
	const workspacePath =
		ancestors(projectPath).find(
			(candidate) => has_pyproject(candidate) && is_uv_workspace(candidate),
		) ?? projectPath;
	return Object.freeze({
		__python_project: true,
		path: projectPath,
		workspace: pythonWorkspaceRef(workspacePath),
	});
}

export function inferPythonProject(path, api) {
	const project = findPythonProject(path);
	if (!project) {
		throw new Error(
			`No pyproject.toml found at or above Python target '${path}'. Pass project: pythonProject(...) to ${api}().`,
		);
	}
	return project;
}

export function assertPythonProject(project, api) {
	if (!project || project.__python_project !== true) {
		throw new Error(`${api}({ project }) expects pythonProject(...)`);
	}
	return project;
}

export function pythonWorkspaceSources(workspace) {
	return files({
		root: workspace.path,
		include: ["pyproject.toml", "**/pyproject.toml", "uv.lock"],
	});
}
