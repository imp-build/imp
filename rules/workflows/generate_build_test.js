import { describe, expect, test } from "//rules/imp/test";
import { configure, product } from "imp:core";
import { generateBuildGoal, registerBuildGenerator } from "//rules/workflows/generate_build";

describe("generate-build workflow", () => {

async function withFakeGoalFlags(flags, fn) {
    const real = globalThis.__host_current_goal_flags;
    globalThis.__host_current_goal_flags = () => JSON.stringify(flags);
    try {
        return await fn();
    } finally {
        globalThis.__host_current_goal_flags = real;
    }
}

test("a registered generator is skipped when its namespace's buildGenerate config is unset", async () => {
    let called = false;
    product("generate-build-test-off", "generate-build", async () => {
        called = true;
        return {};
    });
    registerBuildGenerator({ namespace: "generate-build-test-off-ns", kind: "generate-build-test-off" });
    configure("generate-build-test-off-ns", null);

    await withFakeGoalFlags({ check: true }, async () => {
        await generateBuildGoal([]);
    });

    expect(called).toBe(false);
});

test("a registered generator is skipped when its namespace's buildGenerate config is false", async () => {
    let called = false;
    product("generate-build-test-false", "generate-build", async () => {
        called = true;
        return {};
    });
    registerBuildGenerator({ namespace: "generate-build-test-false-ns", kind: "generate-build-test-false" });
    configure("generate-build-test-false-ns", null);
    configure("generate-build-test-false-ns", { buildGenerate: false });

    await withFakeGoalFlags({ check: true }, async () => {
        await generateBuildGoal([]);
    });

    expect(called).toBe(false);
});

test("a registered generator runs when its namespace's buildGenerate config is true", async () => {
    let called = false;
    product("generate-build-test-on", "generate-build", async () => {
        called = true;
        return {};
    });
    registerBuildGenerator({ namespace: "generate-build-test-on-ns", kind: "generate-build-test-on" });
    configure("generate-build-test-on-ns", null);
    configure("generate-build-test-on-ns", { buildGenerate: true });

    await withFakeGoalFlags({ check: true }, async () => {
        await generateBuildGoal([]);
    });

    expect(called).toBe(true);
});

});
