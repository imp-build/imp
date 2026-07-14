import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    product,
    target,
    BUILD,
    targetKind,
} from "imp:core";
const K_build_workflow_artifact_a = targetKind("build-workflow-artifact-a");
const K_build_workflow_artifact_b = targetKind("build-workflow-artifact-b");
const K_build_workflow_broken = targetKind("build-workflow-broken");
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

test("buildGoal logs a plain count after successful builds, not artifact paths", async () => {
    product(K_build_workflow_artifact_a, BUILD, async () => ({
        stdout: "hello\nworld\n",
        stderr: "",
        exitCode: 0,
        outputs: [{ kind: "file", path: "build/app.txt" }],
    }));
    product(K_build_workflow_artifact_b, BUILD, async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        outputs: [{ kind: "directory", path: "build/assets" }],
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
        expect(logs[0].message).toBe("Built 2 targets");
        expect(logs[0].message).not.toContain("build/app.txt");
        expect(logs[0].message).not.toContain("hello");
        expect(logs[0].message).not.toContain("stdout");
    });
});

test("buildGoal fails with the target label when a build product throws", async () => {
    product(K_build_workflow_broken, BUILD, async () => {
        throw new Error("boom");
    });
    const broken = target({ kind: "build-workflow-broken" });

    let message = "";
    try {
        await buildGoal([
            { id: broken.__id, address: "//:broken", kind: "build-workflow-broken", product: "build" },
        ]);
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("//:broken#build");
    expect(message).toContain("boom");
});

});
