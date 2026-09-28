import {
	pythonApp,
	pythonProject,
	pythonSources,
	pythonTest,
	pythonWorkspace,
} from "//rules/python";
import { jsSources } from "//rules/js";

export const workspace = pythonWorkspace({ path: "rules/python/example" });
const project = pythonProject({ workspace, path: "." });

export const hello = pythonApp({
	project,
	base: "rules/python/example",
	entryPoint: "hello.__main__",
	sources: ["src/**/*.py"],
});

// Direct script execution, separate from the packaged app above: each file
// under scripts/ becomes its own selectable run root.
export const scripts = pythonSources({
	root: "rules/python/example/scripts",
});

export const hello_test = pythonTest({
	project,
	base: "rules/python/example",
	sources: ["tests/**/*.py"],
});
export const js = jsSources({ base: "rules/python/example" });
