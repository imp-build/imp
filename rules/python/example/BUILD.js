import { pythonApp, pythonTest } from "//rules/python";
import { jsSources } from "//rules/js";

export const hello = pythonApp({
	base: "rules/python/example",
	entryPoint: "hello.__main__",
});

export const hello_test = pythonTest({ base: "rules/python/example" });
export const js = jsSources({ base: "rules/python/example" });
