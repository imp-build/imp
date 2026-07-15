import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinPackageFmt,
    odinTestPackageFmt,
    odinPackageFormatCheck,
    odinTestPackageFormatCheck,
    fmtGoal,
} from "//rules/workflows/fmt";
import {
    product,
    target,
    FMT,
    targetKind,
    toolName,
} from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
const TEST_TOOL = toolName("fmt-test-tool");
const K_fmt_goal_test_clean = targetKind("fmt-goal-test-clean");
const K_fmt_goal_test_dirty_a = targetKind("fmt-goal-test-dirty-a");
const K_fmt_goal_test_dirty_b = targetKind("fmt-goal-test-dirty-b");
const K_fmt_goal_test_all_clean = targetKind("fmt-goal-test-all-clean");
const K_fmt_goal_test_reformat = targetKind("fmt-goal-test-reformat");

describe("fmt workflow", () => {

test("fmt/format-check products are declared for odin-package and odin-test-package", () => {
    expect(typeof odinPackageFmt).toBe("function");
    expect(typeof odinTestPackageFmt).toBe("function");
    expect(typeof odinPackageFormatCheck).toBe("function");
    expect(typeof odinTestPackageFormatCheck).toBe("function");
});

async function withFakeGoalFlags(flags, fn) {
    const real = globalThis.__host_current_goal_flags;
    globalThis.__host_current_goal_flags = () => JSON.stringify(flags);
    try {
        return await fn();
    } finally {
        globalThis.__host_current_goal_flags = real;
    }
}

async function withFakeLog(fn) {
    const real = globalThis.__host_log;
    const logs = [];
    globalThis.__host_log = (level, message) => { logs.push({ level, message }); };
    try {
        await fn(logs);
    } finally {
        if (real === undefined) delete globalThis.__host_log;
        else globalThis.__host_log = real;
    }
}

test("fmtGoal --check runs and reports every target before throwing", async () => {
    product(K_fmt_goal_test_clean, FORMAT_CHECK, TEST_TOOL, async () => ({ checked: 1, unformatted: [] }));
    product(K_fmt_goal_test_dirty_a, FORMAT_CHECK, TEST_TOOL, async () => ({ checked: 1, unformatted: ["a/one.odin"] }));
    product(K_fmt_goal_test_dirty_b, FORMAT_CHECK, TEST_TOOL, async () => ({ checked: 2, unformatted: ["b/one.odin", "b/two.odin"] }));
    const clean = target({ kind: "fmt-goal-test-clean" });
    const dirtyA = target({ kind: "fmt-goal-test-dirty-a" });
    const dirtyB = target({ kind: "fmt-goal-test-dirty-b" });

    await withFakeGoalFlags({ check: true }, async () => {
        let message = "";
        await withFakeLog(async (logs) => {
            try {
                await fmtGoal([
                    { id: clean.__id, address: "//:clean", kind: "fmt-goal-test-clean", product: "fmt" },
                    { id: dirtyA.__id, address: "//:a", kind: "fmt-goal-test-dirty-a", product: "fmt" },
                    { id: dirtyB.__id, address: "//:b", kind: "fmt-goal-test-dirty-b", product: "fmt" },
                ]);
            } catch (error) {
                message = error.message;
            }
            // Both unformatted targets are named, not just the first one hit —
            // the loop finishes checking every target before deciding to throw.
            expect(message).toContain("//:a#format-check");
            expect(message).toContain("a/one.odin");
            expect(message).toContain("//:b#format-check");
            expect(message).toContain("b/one.odin");
            expect(message).toContain("b/two.odin");
            expect(logs.some((l) => l.message.includes("//:a#format-check"))).toBe(true);
            expect(logs.some((l) => l.message.includes("//:b#format-check"))).toBe(true);
            expect(logs.some((l) => l.message.includes("//:clean#format-check"))).toBe(false);
        });
    });
});

test("fmtGoal --check does not throw when every target is already formatted", async () => {
    product(K_fmt_goal_test_all_clean, FORMAT_CHECK, TEST_TOOL, async () => ({ checked: 1, unformatted: [] }));
    const clean = target({ kind: "fmt-goal-test-all-clean" });

    await withFakeGoalFlags({ check: true }, async () => {
        await fmtGoal([
            { id: clean.__id, address: "//:clean", kind: "fmt-goal-test-all-clean", product: "fmt" },
        ]);
    });
});

test("fmtGoal without --check reformats and reports change counts, never throws on its own", async () => {
    product(K_fmt_goal_test_reformat, FMT, TEST_TOOL, async () => ({ formatted: 3 }));
    const pkg = target({ kind: "fmt-goal-test-reformat" });

    await withFakeGoalFlags({ check: false }, async () => {
        await withFakeLog(async (logs) => {
            await fmtGoal([
                { id: pkg.__id, address: "//:pkg", kind: "fmt-goal-test-reformat", product: "fmt" },
            ]);
            expect(logs.some((l) => l.message.includes("//:pkg#fmt") && l.message.includes("3 file(s) reformatted"))).toBe(true);
        });
    });
});

});
