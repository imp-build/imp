import {
    describe,
    expect,
    test,
    withFakeRun,
} from "//rules/imp/test";
import {
    odinFmt,
    odinFormatCheck,
} from "//rules/odin/fmt";
import {
    odinPackage,
} from "//rules/odin";
import {
    getMemoTrace,
} from "imp:core";

describe("Odin fmt mechanics", () => {

test("odinFmt runs odinfmt -w over the package's own sources and writes them back", async () => {
    await withFakeRun(async () => {
        const pkg = odinPackage({ path: "rules/odin/example", srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
        const result = await odinFmt(pkg);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display.startsWith("odinfmt "));
        expect(runEffect.argv[2]).toContain("-w");
        expect(runEffect.outputs).toEqual([{ kind: "file", path: "rules/odin/example/main.odin" }]);
        expect(result).toEqual({ formatted: 1 });
    });
});

test("odinFormatCheck diffs in the sandbox without declaring outputs", async () => {
    await withFakeRun(async () => {
        const pkg = odinPackage({ path: "rules/odin/example", srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
        const result = await odinFormatCheck(pkg);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display.startsWith("odinfmt --check"));
        expect(runEffect.outputs).toEqual([]);
        expect(result).toEqual({ checked: 1 });
    });
});

test("odinFmt returns formatted: 0 without invoking run when there are no sources", async () => {
    await withFakeRun(async () => {
        const pkg = odinPackage({ path: "rules/odin/example", srcs: ["missing*.odin"], toolchain: "dev-2026-04" });
        const result = await odinFmt(pkg);
        const { trace } = getMemoTrace();
        expect(trace.some(t => t.event === "effect" && t.kind === "run")).toBe(false);
        expect(result).toEqual({ formatted: 0 });
    });
});

test("odinFormatCheck returns checked: 0 without invoking run when there are no sources", async () => {
    await withFakeRun(async () => {
        const pkg = odinPackage({ path: "rules/odin/example", srcs: ["missing*.odin"], toolchain: "dev-2026-04" });
        const result = await odinFormatCheck(pkg);
        const { trace } = getMemoTrace();
        expect(trace.some(t => t.event === "effect" && t.kind === "run")).toBe(false);
        expect(result).toEqual({ checked: 0 });
    });
});

});
