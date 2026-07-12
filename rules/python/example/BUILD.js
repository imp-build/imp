import { pythonApp } from "//rules/python";
import { pythonTest } from "//rules/python/test";
import { uvToolchain } from "//rules/python/uv_toolchain";
import { pexToolchain } from "//rules/python/pex_toolchain";

uvToolchain("0.11.16", { default: true });
// --venv-repository was introduced in pex 2.59.0 — must stay at or above it.
pexToolchain("2.97.1", { default: true });

export const hello = pythonApp({
    entryPoint: "hello.__main__",
});

export const hello_test = pythonTest({});
