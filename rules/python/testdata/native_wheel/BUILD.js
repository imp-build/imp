import { pythonApp, pythonTest } from "//rules/python";

export const app = pythonApp({
	base: "rules/python/testdata/native_wheel",
	entryPoint: "native_app.__main__",
	sources: ["src/**/*.py"],
});

export const tests = pythonTest({
	base: "rules/python/testdata/native_wheel",
	sources: ["tests/**/*.py"],
});
