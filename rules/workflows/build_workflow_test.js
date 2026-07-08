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
    buildGoal,
} from "//rules/workflows/build_workflow";

async function withFakeLog(fn) {
    const real = globalThis.__host_log;
    const logs = [];
    globalThis.__host_log = (level, message) => {
        logs.push({ level, message });
    };
    try {
        await fn(logs);
    } finally {
        if (real === undefined) {
            delete globalThis.__host_log;
        } else {
            globalThis.__host_log = real;
        }
    }
}

describe("build workflow", () => {

test("buildGoal logs each target to artifact path mapping after successful builds", async () => {
    product("build-workflow-artifact-a", "build", async () => ({
        stdout: "hello\nworld\n",
        stderr: "",
        exitCode: 0,
        outputs: [{ kind: "file", path: "dist/app.txt" }],
    }));
    product("build-workflow-artifact-b", "build", async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        outputs: [{ kind: "directory", path: "dist/assets" }],
    }));
    const a = target({ kind: "build-workflow-artifact-a" });
    const b = target({ kind: "build-workflow-artifact-b" });

    await withFakeLog(async (logs) => {
        await buildGoal([
            { id: a.__id, address: "//:a", kind: "build-workflow-artifact-a", product: "build" },
            { id: b.__id, address: "//:b", kind: "build-workflow-artifact-b", product: "build" },
        ]);

        expect(logs.length).toBe(1);
        expect(logs[0].level).toBe("info");
        expect(logs[0].message).toContain("Build artifacts:");
        expect(logs[0].message).toContain("//:a#build");
        expect(logs[0].message).toContain("-> dist/app.txt");
        expect(logs[0].message).toContain("//:b#build");
        expect(logs[0].message).toContain("-> dist/assets");
        expect(logs[0].message).not.toContain("hello");
        expect(logs[0].message).not.toContain("world");
        expect(logs[0].message).not.toContain("stdout");
    });
});

test("buildGoal fails when a build product declares no output artifacts", async () => {
    product("build-workflow-no-artifacts", "build", async () => ({
        stdout: "nothing built\n",
        stderr: "",
        exitCode: 0,
        outputs: [],
    }));
    const broken = target({ kind: "build-workflow-no-artifacts" });

    let message = "";
    try {
        await buildGoal([
            { id: broken.__id, address: "//:broken", kind: "build-workflow-no-artifacts", product: "build" },
        ]);
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("//:broken#build");
    expect(message).toContain("did not declare any output artifacts");
});

});
