import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    product,
    target,
} from "imp:core";
import {
    requireSingleOdinPackage,
    runGoal,
} from "//rules/workflows/run";

describe("run workflow", () => {

test("requireSingleOdinPackage passes through zero or one odin-package target", () => {
    expect(() => requireSingleOdinPackage([])).not.toThrow();
    expect(() => requireSingleOdinPackage([{ address: "//:a", kind: "odin-package" }])).not.toThrow();
});

test("requireSingleOdinPackage ignores non-odin-package targets in the selection", () => {
    expect(() => requireSingleOdinPackage([
        { address: "//:a", kind: "odin-package" },
        { address: "//:vs", kind: "vs-workspace" },
    ])).not.toThrow();
});

test("requireSingleOdinPackage rejects more than one odin-package target, naming every offender", () => {
    let message = "";
    try {
        requireSingleOdinPackage([
            { address: "//:a", kind: "odin-package" },
            { address: "//:b", kind: "odin-package" },
        ]);
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("run requires a single target");
    expect(message).toContain("//:a");
    expect(message).toContain("//:b");
});

test("runGoal rejects a multi-target odin-package selection before dispatching anything", async () => {
    let ran = false;
    product("run-test-reject-kind", "run", async () => { ran = true; });

    let message = "";
    try {
        await runGoal([
            { address: "//:a", kind: "odin-package" },
            { address: "//:b", kind: "odin-package" },
        ]);
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("run requires a single target");
    expect(ran).toBe(false);
});

test("runGoal dispatches the sole selected target's registered product", async () => {
    let ranWith = null;
    product("run-test-dispatch-kind", "run", async (handle) => { ranWith = handle; });
    const fake = target({ kind: "run-test-dispatch-kind" });

    await runGoal([
        { id: fake.__id, address: "//:fake", kind: "run-test-dispatch-kind", product: "run" },
    ]);

    expect(ranWith).toBe(fake);
});

});
