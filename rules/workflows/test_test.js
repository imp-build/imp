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
    testGoal,
} from "//rules/workflows/test";

describe("test workflow", () => {

test("testGoal dispatches every selected target, regardless of kind", async () => {
    const ran = [];
    product("test-workflow-test-a", "test", async (handle) => { ran.push(handle.kind); });
    product("test-workflow-test-b", "test", async (handle) => { ran.push(handle.kind); });
    const a = target({ kind: "test-workflow-test-a" });
    const b = target({ kind: "test-workflow-test-b" });

    await testGoal([
        { id: a.__id, address: "//:a", kind: "test-workflow-test-a", product: "test" },
        { id: b.__id, address: "//:b", kind: "test-workflow-test-b", product: "test" },
    ]);

    expect(ran.length).toBe(2);
    expect(ran).toContain("test-workflow-test-a");
    expect(ran).toContain("test-workflow-test-b");
});

});
