// pytest test runner: a whole-suite target, same shape as cargoTest
// (rules/rust/index.js) and odinTest (rules/odin/index.js) — one sandboxed
// `pytest` invocation covers the whole target's source tree, not a per-file
// fan-out like rust_test's expandCargoTests. No pex packaging step: unlike
// pythonApp, a test run never needs to be packaged first, so this syncs its
// own throwaway venv directly via uv, independent of PythonApp.

import { Target, glob, product, run, TEST } from "imp:core";

import { declared_path, sandboxRootEnvExports, sources } from "//rules/python";

import {
    defaultUvToolchain,
    uvCacheDirEnv,
    uvCacheDirTool,
    uvTool,
    UV_TOOL,
} from "//rules/python/uv_toolchain";

export class PythonTest extends Target {
    static kind = "python-test";
    constructor({ src = ".", testArgs = [], uvVersion, deps = [] }) {
        const explicitUvTarget = uvVersion && uvVersion.__imp === true ? uvVersion : null;
        const explicitUvVersion = uvVersion && uvVersion.__imp !== true ? uvVersion : null;
        const uvToolchainTarget = explicitUvTarget || (!explicitUvVersion ? defaultUvToolchain() : null);
        const resolvedUvVersion = explicitUvVersion || (uvToolchainTarget && uvToolchainTarget.attrs?.version);

        const allDeps = [
            ...(uvToolchainTarget ? [{ target: uvToolchainTarget, mode: "tool" }] : []),
            ...deps,
        ];

        super({
            kind: PythonTest.kind,
            attrs: {
                src,
                ...(testArgs.length ? { testArgs } : {}),
                ...(resolvedUvVersion ? { uvVersion: resolvedUvVersion } : {}),
                ...(uvToolchainTarget ? { uvToolchainTarget } : {}),
                ...(allDeps.length ? { deps: allDeps.map(dep => dep.target || dep) } : {}),
            },
            deps: allDeps,
        });
    }
}

/**
 * Declare a pytest test suite over a Python project directory.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.src="."] Workspace-relative Python project directory.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to pytest.
 * @param {object|string} [opts.uvVersion] uv toolchain target handle or version string.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Target handle.
 */
export function pythonTest({ src, testArgs, uvVersion, deps }) {
    return new PythonTest({ src, testArgs, uvVersion, deps });
}

// No outputs/materialize on this final step: test results aren't
// user-addressable artifacts. impure: true so a re-run always executes
// pytest rather than replaying a cached pass/fail from the task cache —
// same choice cargoTest/odinTest/runCTest make.
export const pythonTestRun = product(PythonTest, TEST, UV_TOOL, async function pythonTestRun(handle) {
    const srcPath = declared_path(handle, handle.attrs.src || ".");
    const inputFiles = await sources(handle);
    const uvToolSpec = await uvTool(handle.attrs.uvVersion);
    const uvCacheToolSpec = uvCacheDirTool();

    const venvPath = `${srcPath}/.venv`;
    const envExports = sandboxRootEnvExports(uvCacheDirEnv());
    const script = `src=$1; venv=$2; shift 2; ` +
        `imp_sandbox_root="$(pwd)" && ${envExports.join(" && ")} && ` +
        'uv sync --project "$src" --frozen --no-progress && ' +
        // Scope pytest's own collection to $src explicitly — the sandbox
        // root also holds tool mounts (.imp/tools/...) that pytest would
        // otherwise try to walk for test discovery.
        '"$venv/bin/python" -m pytest "$src" "$@"';

    return run({
        argv: ["sh", "-c", script, "python-test", srcPath, venvPath, ...(handle.attrs.testArgs || [])],
        tools: [uvToolSpec, uvCacheToolSpec],
        inputs: [inputFiles],
        impure: true,
        display: `python test ${srcPath}`,
    });
});
