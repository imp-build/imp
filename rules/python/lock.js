import { files, output, resolveGraphHandle, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	uvCacheDirEnv,
	uvCacheDirSeed,
	uvCacheDirTool,
} from "//rules/python/uv_toolchain";

const PROJECT_LOCK_INPUTS = ["pyproject.toml", "uv.lock"];

function sandboxRootEnvExports(envEntries) {
	return envEntries.map((entry) => {
		const eq = entry.indexOf("=");
		return `export ${entry.slice(0, eq)}="$IMP_SANDBOX_ROOT/${entry.slice(eq + 1)}"`;
	});
}

function projectLockPath(project) {
	return project === "." ? "uv.lock" : `${project}/uv.lock`;
}

/**
 * Declare a graph root that re-locks one Python project with uv.
 *
 * The task stages the project metadata and existing lock, then publishes only
 * the resulting uv.lock at the gen-lockfiles goal boundary.
 */
export function pythonProjectLock({ project, uv, pythonVersion }) {
	const lockPath = projectLockPath(project);
	return task({
		display: `gen Python lockfile ${project}`,
		// uv lock reads live package indexes and writes a workspace file. Do not
		// reuse a previous result when the operation is selected explicitly.
		cache: false,
		inputs: {
			sources: files({ root: project, include: PROJECT_LOCK_INPUTS }),
			project,
			shell: nativeTool("sh"),
			uv,
			pythonVersion,
		},
		outputs: { result: output.value() },
		async run(exec, inputs) {
			await resolveGraphHandle(uvCacheDirSeed());
			const envExports = sandboxRootEnvExports(uvCacheDirEnv());
			const action = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					`${envExports.join(" && ")} && exec "$1" lock --project "$2" --no-progress --managed-python --python "$3"`,
					"python-project-lock",
					exec.tool(inputs.uv, "uv"),
					inputs.project,
					inputs.pythonVersion,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell, inputs.uv, uvCacheDirTool()],
				outputs: { lockfile: output.file(lockPath) },
				display: `lock Python project ${inputs.project}`,
			});
			return {
				result: {
					kind: "python-project-lock",
					project: inputs.project,
					path: lockPath,
					lockfile: action.outputs.lockfile,
				},
			};
		},
	}).outputs.result;
}
