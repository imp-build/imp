import { pythonApp, pythonSources, pythonTest } from "//rules/python";
import { jsSources } from "//rules/js";

export const hello = pythonApp({
	base: "rules/python/example",
	entryPoint: "hello.__main__",
});

// Direct script execution, separate from the packaged app above: each file
// under scripts/ becomes its own selectable run root.
export const scripts = pythonSources({
	root: "rules/python/example/scripts",
});

export const hello_test = pythonTest({ base: "rules/python/example" });
export const js = jsSources({ base: "rules/python/example" });
