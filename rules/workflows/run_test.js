import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    requireSingleOdinPackage,
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

});
