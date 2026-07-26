import { pythonApp } from "//rules/python";
import { pythonTest } from "//rules/python/test";
import { jsSources } from "//rules/js";

export const hello = pythonApp({
	entryPoint: "hello.__main__",
});

export const hello_test = pythonTest({});
export const js = jsSources({});
