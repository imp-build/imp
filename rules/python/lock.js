import { output, resolveGraphHandle, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	uvCacheDirEnv,
	uvCacheDirSeed,
	uvCacheDirTool,
} from "//rules/python/uv_toolchain";

function sandboxRootEnvExports(envEntries) {
	return envEntries.map((entry) => {
		const eq = entry.indexOf("=");
		return `export ${entry.slice(0, eq)}="$IMP_SANDBOX_ROOT/${entry.slice(eq + 1)}"`;
	});
}

function workspaceLockPath(workspace) {
	return workspace === "." ? "uv.lock" : `${workspace}/uv.lock`;
}

/**
 * Declare a graph root that re-locks one uv workspace with uv.
 *
 * The task stages workspace metadata and the existing lock, then publishes
 * only the resulting uv.lock at the gen-lockfiles goal boundary.
 */
export function pythonWorkspaceLock({ workspace, sources, uv, pythonVersion }) {
	const lockPath = workspaceLockPath(workspace);
	return task({
		display: `gen Python workspace lockfile ${workspace}`,
		// uv lock reads live package indexes and writes a workspace file. Do not
		// reuse a previous result when the operation is selected explicitly.
		cache: false,
		inputs: {
			sources,
			workspace,
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
					"python-workspace-lock",
					exec.tool(inputs.uv, "uv"),
					inputs.workspace,
					inputs.pythonVersion,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell, inputs.uv, uvCacheDirTool()],
				outputs: { lockfile: output.file(lockPath) },
				display: `lock Python workspace ${inputs.workspace}`,
			});
			return {
				result: {
					kind: "python-workspace-lock",
					workspace: inputs.workspace,
					path: lockPath,
					lockfile: action.outputs.lockfile,
				},
			};
		},
	}).outputs.result;
}
