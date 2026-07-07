import { Target, product, run, glob, workspaceFiles, resetMemoState } from "imp:core";

const suites = [];
const tests = [];

function fullName(name) {
    return [...suites, name].join(" ");
}

function formatValue(value) {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (value === undefined) {
        return "undefined";
    }
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

function isObject(value) {
    return value !== null && typeof value === "object";
}

function deepEqual(actual, expected) {
    if (Object.is(actual, expected)) {
        return true;
    }
    if (Array.isArray(actual) || Array.isArray(expected)) {
        if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
            return false;
        }
        return actual.every((value, index) => deepEqual(value, expected[index]));
    }
    if (isObject(actual) || isObject(expected)) {
        if (!isObject(actual) || !isObject(expected)) {
            return false;
        }
        const actualKeys = Object.keys(actual).sort();
        const expectedKeys = Object.keys(expected).sort();
        if (!deepEqual(actualKeys, expectedKeys)) {
            return false;
        }
        return actualKeys.every((key) => deepEqual(actual[key], expected[key]));
    }
    return false;
}

function failMatcher(name, actual, expected, negated) {
    const not = negated ? " not" : "";
    throw new Error(`${name}: expected ${formatValue(actual)}${not} to match ${formatValue(expected)}`);
}

function makeMatchers(actual, negated = false) {
    function check(name, passed, expected) {
        const ok = negated ? !passed : passed;
        if (!ok) {
            failMatcher(name, actual, expected, negated);
        }
    }

    return {
        get not() {
            return makeMatchers(actual, !negated);
        },
        toBe(expected) {
            check("toBe", Object.is(actual, expected), expected);
        },
        toEqual(expected) {
            check("toEqual", deepEqual(actual, expected), expected);
        },
        toContain(expected) {
            const passed = typeof actual === "string"
                ? actual.includes(expected)
                : Array.isArray(actual) && actual.includes(expected);
            check("toContain", passed, expected);
        },
        toBeTruthy() {
            check("toBeTruthy", !!actual, true);
        },
        toBeFalsy() {
            check("toBeFalsy", !actual, false);
        },
        toThrow(expected) {
            if (typeof actual !== "function") {
                throw new Error(`toThrow: expected ${formatValue(actual)} to be a function`);
            }
            let thrown = null;
            try {
                actual();
            } catch (error) {
                thrown = error;
            }
            const message = thrown && thrown.message ? thrown.message : String(thrown);
            const passed = thrown !== null && (
                expected === undefined
                    || (typeof expected === "string" && message.includes(expected))
                    || (expected instanceof RegExp && expected.test(message))
            );
            check("toThrow", passed, expected === undefined ? "an error" : expected);
        },
    };
}

export function expect(actual) {
    return makeMatchers(actual);
}

export function describe(name, fn) {
    suites.push(name);
    try {
        fn();
    } finally {
        suites.pop();
    }
}

export function test(name, fn) {
    tests.push({ name: fullName(name), fn });
}

export const it = test;

/**
 * Run a test body with `__host_run` stubbed out, so `run()` calls resolve
 * without executing anything. Effects are still traced (tracing happens
 * before the host bridge), so `getMemoTrace()` assertions work unchanged.
 */
export async function withFakeRun(fn) {
    const real = globalThis.__host_run;
    globalThis.__host_run = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    try {
        return await fn();
    } finally {
        globalThis.__host_run = real;
    }
}

/**
 * Run a test body with `__host_diff_digests` stubbed out, so `diffDigests()`
 * returns a fixed, caller-provided set of changes regardless of the (fake or
 * real) digests it's called with — for tests that fake `run()` (so there's no
 * real output digest to diff against) but still want to exercise the
 * diff-driven branch of a product.
 *
 * @param {Array<{type: "added"|"removed"|"modified", path: string}>} changes
 * @param {() => Promise<any>} fn
 */
export async function withFakeDiff(changes, fn) {
    const real = globalThis.__host_diff_digests;
    globalThis.__host_diff_digests = () => JSON.stringify(changes);
    try {
        return await fn();
    } finally {
        globalThis.__host_diff_digests = real;
    }
}

/**
 * Run a test body with `__host_selected_targets` stubbed to return `list`,
 * so `selectedTargets()` works inside a test even though tests run outside
 * of `execute_goal_live` (where the real binding always errors).
 *
 * @param {Array<{ id: number, address: string, kind: string, product: string }>} list
 * @param {() => Promise<any>} fn
 */
export async function withFakeSelectedTargets(list, fn) {
    const real = globalThis.__host_selected_targets;
    globalThis.__host_selected_targets = () => JSON.stringify(list);
    try {
        return await fn();
    } finally {
        globalThis.__host_selected_targets = real;
    }
}

/**
 * Run a test body with toolchain host bridge calls stubbed. This is for
 * testing rule-layer toolchain declaration/acquisition logic without network,
 * archive extraction, or real native-tool resolution.
 */
export async function withFakeToolchainHost(platOrFn, maybeFn) {
    const plat = typeof platOrFn === "function" ? { os: "linux", arch: "x86_64" } : platOrFn;
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const calls = [];
    const runs = [];
    const cache = new Map();

    const originals = {
        target: globalThis.__host_target,
        namedCache: globalThis.__host_named_cache,
        platformInfo: globalThis.__host_platform_info,
        cacheHas: globalThis.__host_cache_has,
        cacheGet: globalThis.__host_cache_get,
        cachePut: globalThis.__host_cache_put,
        download: globalThis.__host_download,
        extract: globalThis.__host_extract,
        run: globalThis.__host_run,
        nativeToolArtifact: globalThis.__host_native_tool_artifact,
    };

    const host = {
        calls,
        runs,
        install(name, key, path) {
            cache.set(`${name}/${key}`, path);
        },
        clearCalls() {
            calls.length = 0;
        },
    };

    globalThis.__host_target = (kind, attrsJson, sourcesJson, depIds, depModes) => {
        if (kind === "native-tool") {
            const attrs = JSON.parse(attrsJson);
            calls.push(["nativeTool", attrs.name]);
        }
        return originals.target(kind, attrsJson, sourcesJson, depIds, depModes);
    };
    globalThis.__host_named_cache = (name) => {
        calls.push(["namedCache", name]);
    };
    globalThis.__host_platform_info = () => {
        calls.push(["platformInfo"]);
        return JSON.stringify(plat);
    };
    globalThis.__host_cache_has = (name, key) => {
        calls.push(["cacheHas", name, key]);
        return cache.has(`${name}/${key}`);
    };
    globalThis.__host_cache_get = (name, key) => {
        calls.push(["cacheGet", name, key]);
        return cache.get(`${name}/${key}`) || null;
    };
    globalThis.__host_cache_put = (name, key, source) => {
        calls.push(["cachePut", name, key, source]);
        cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
    };
    globalThis.__host_download = (url) => {
        calls.push(["download", url]);
        return "/downloads/odin-release";
    };
    globalThis.__host_extract = (archive, dest, format, stripComponents) => {
        calls.push(["extract", archive, dest, format, stripComponents]);
    };
    globalThis.__host_native_tool_artifact = (name) => {
        calls.push(["nativeToolSpec", name]);
        return `/tools/${name}`;
    };
    globalThis.__host_run = async (opts) => {
        runs.push(opts);
        for (const out of opts.outputs || []) {
            if (out.namedCache) {
                cache.set(`${out.namedCache.name}/${out.namedCache.key}`, `/cache/${out.namedCache.name}/${out.namedCache.key}`);
            }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
    };

    try {
        return await fn(host);
    } finally {
        globalThis.__host_target = originals.target;
        globalThis.__host_named_cache = originals.namedCache;
        globalThis.__host_platform_info = originals.platformInfo;
        globalThis.__host_cache_has = originals.cacheHas;
        globalThis.__host_cache_get = originals.cacheGet;
        globalThis.__host_cache_put = originals.cachePut;
        globalThis.__host_download = originals.download;
        globalThis.__host_extract = originals.extract;
        globalThis.__host_run = originals.run;
        globalThis.__host_native_tool_artifact = originals.nativeToolArtifact;
    }
}

async function runRegisteredTests({ from = 0, label = "tests" } = {}) {
    const selected = tests.slice(from);
    if (selected.length === 0) {
        throw new Error(`no tests registered for ${label}`);
    }

    const failures = [];
    for (const entry of selected) {
        try {
            resetMemoState();
            await entry.fn();
        } catch (error) {
            failures.push({
                name: entry.name,
                message: error && error.message ? error.message : String(error),
            });
        }
    }

    if (failures.length > 0) {
        const lines = failures.map((failure) => `  ${failure.name}: ${failure.message}`);
        throw new Error(
            `JS tests failed for ${label}: ${failures.length}/${selected.length}\n${lines.join("\n")}`,
        );
    }
}

/**
 * Import each test module and run the tests it registers. Entry point for the
 * hidden `imp rules-test` subcommand.
 */
export async function runTestModules(modules) {
    const firstTest = tests.length;
    for (const testModule of modules) {
        await import(testModule);
    }
    await runRegisteredTests({ from: firstTest, label: modules.join(", ") });
}

// Each rules-test target runs in its own imp subprocess: tests share
// runtime-global memo state, so suites must not share a runtime with each
// other or with the invoking workspace evaluation. Unsandboxed (and impure,
// since the cache key cannot see the host binary's content yet — see ROADMAP
// tool fingerprinting gap) because suites like native_tool_test/
// tracked_apis_test deliberately probe real host state (`which`, `env`,
// ambient PATH) — the point of those tests is to exercise the real
// environment, not a hermetic one.
export const test_product = product("rules-test", "test", async function test_product(handle) {
    const testModules = handle.attrs.tests
        .split(",")
        .map((testModule) => testModule.trim())
        .filter((testModule) => testModule.length > 0);

    return run({
        argv: [globalThis.__imp_self_bin, "rules-test", ...testModules],
        // Tests glob example sources and resources, not just modules — stage
        // the whole rules tree.
        inputs: [glob({ include: ["rules/**/*", "imp.workspace.js"] })],
        // Share the host cache so toolchain named-cache lookups hit instead of
        // re-downloading into the sandbox's pinned HOME.
        env: [`IMP_CACHE_DIR=${globalThis.__imp_cache_dir}`],
        display: `test JS rules ${handle.attrs.root}`,
        sandbox: false,
        impure: true,
    });
});

export class RulesTest extends Target {
    static kind = "rules-test";
    constructor({ root }) {
        const discoveredTests = workspaceFiles({ root, suffix: "_test.js" });
        if (discoveredTests.length === 0) {
            throw new Error(`no JS rule tests found below ${root}`);
        }

        super({
            kind: RulesTest.kind,
            attrs: {
                root,
                tests: discoveredTests.join(","),
            },
        });
    }
}

/**
 * Declare a JS rule-test target for one workspace directory.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.root Workspace-rooted directory, e.g. "//rules/odin".
 * @returns {object} Target handle.
 */
export function rulesTest({ root }) {
    return new RulesTest({ root });
}
