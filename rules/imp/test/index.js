import { target, rule, workspaceFiles } from "imp:core";

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

async function runRegisteredTests({ from = 0, label = "tests" } = {}) {
    const selected = tests.slice(from);
    if (selected.length === 0) {
        throw new Error(`no tests registered for ${label}`);
    }

    const failures = [];
    for (const entry of selected) {
        try {
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

async function rulesTestExec(target, ctx) {
    const testModules = target.fields.tests
        .split(",")
        .map((testModule) => testModule.trim())
        .filter((testModule) => testModule.length > 0);
    const firstTest = tests.length;

    for (const testModule of testModules) {
        await import(testModule);
    }

    await runRegisteredTests({ from: firstTest, label: target.fields.root });
}

rule({
    kind: "rules-test",
    product: "test",
    action: "test JS rules",
    exec: rulesTestExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

/**
 * Declare a JS rule-test target for one workspace directory.
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-rooted directory, e.g. "//rules/odin".
 * @returns {object} Target handle.
 */
export function rulesTest({ root }) {
    const discoveredTests = workspaceFiles({ root, suffix: "_test.js" });
    if (discoveredTests.length === 0) {
        throw new Error(`no JS rule tests found below ${root}`);
    }

    return target({
        kind: "rules-test",
        fields: {
            root,
            tests: discoveredTests.join(","),
        },
    });
}
