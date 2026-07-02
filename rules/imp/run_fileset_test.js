import { describe, expect, test } from "//rules/imp/test";
import { glob, file_set, run, output, paths, getMemoTrace } from "imp:core";

describe("run() with FileSet inputs", () => {

test("run accepts a glob FileSet in inputs", async () => {
    const srcs = glob({ root: "rules/imp", include: ["tracked_apis_test.js"] });
    const result = await run({ argv: ["sh", "-c", "true"], inputs: [srcs], impure: true });
    expect(result.exitCode).toBe(0);
});

test("run copies glob files into sandbox", async () => {
    const srcs = glob({ root: "rules/imp", include: ["tracked_apis_test.js"] });
    const result = await run({
        argv: ["sh", "-c", "test -f rules/imp/tracked_apis_test.js"],
        inputs: [srcs],
        impure: true,
    });
    expect(result.exitCode).toBe(0);
});

test("run accepts a literal FileSet in inputs", async () => {
    const srcs = file_set.literal(["rules/imp/tracked_apis_test.js"]);
    const result = await run({
        argv: ["sh", "-c", "test -f rules/imp/tracked_apis_test.js"],
        inputs: [srcs],
        impure: true,
    });
    expect(result.exitCode).toBe(0);
});

test("run accepts a union FileSet in inputs", async () => {
    const a = glob({ root: "rules/imp", include: ["memo_test.js"] });
    const b = glob({ root: "rules/imp", include: ["product_test.js"] });
    const result = await run({
        argv: ["sh", "-c", "test -f rules/imp/memo_test.js && test -f rules/imp/product_test.js"],
        inputs: [file_set.union(a, b)],
        impure: true,
    });
    expect(result.exitCode).toBe(0);
});

test("run accepts empty inputs array", async () => {
    const result = await run({ argv: ["sh", "-c", "true"], inputs: [], impure: true });
    expect(result.exitCode).toBe(0);
});

test("run accepts mixed FileSet and plain spec in inputs", async () => {
    const srcs = glob({ root: "rules/imp", include: ["memo_test.js"] });
    const plain = { kind: "file", path: "rules/imp/product_test.js" };
    const result = await run({
        argv: ["sh", "-c", "test -f rules/imp/memo_test.js && test -f rules/imp/product_test.js"],
        inputs: [srcs, plain],
        impure: true,
    });
    expect(result.exitCode).toBe(0);
});

test("materialising a FileSet input records a paths effect entry", async () => {
    const srcs = glob({ root: "rules/imp", include: ["memo_test.js"] });
    await run({ argv: ["sh", "-c", "true"], inputs: [srcs], impure: true });
    const { trace } = getMemoTrace();
    const pathsEffects = trace.filter(t => t.event === "effect" && t.kind === "paths");
    expect(pathsEffects.length).toBe(1);
    expect(pathsEffects[0].fileset_kind).toBe("glob");
});

});

describe("output()", () => {

test("output returns a file spec by default", async () => {
    const spec = output("bin/foo");
    expect(spec.kind).toBe("file");
    expect(spec.path).toBe("bin/foo");
});

test("output respects explicit kind", async () => {
    const spec = output("dist/", { kind: "directory" });
    expect(spec.kind).toBe("directory");
    expect(spec.path).toBe("dist/");
});

});
