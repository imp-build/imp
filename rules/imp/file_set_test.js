import { describe, expect, test } from "//rules/imp/test";
import { glob, paths, file_set, memo, getMemoTrace, resetMemoState } from "imp:core";

describe("FileSet", () => {

test("glob() returns a FileSet descriptor, not paths", async () => {
    const fs = glob({ root: "rules/imp", include: ["*.js"] });
    expect(fs.__fileset).toBe(true);
    expect(fs.kind).toBe("glob");
    expect(Array.isArray(fs.include)).toBe(true);
});

test("glob() records no effect entry on its own", async () => {
    resetMemoState();
    glob({ root: "rules/imp", include: ["*.js"] });
    const { trace } = getMemoTrace();
    expect(trace.filter(t => t.event === "effect").length).toBe(0);
});

test("paths(glob(...)) returns a non-empty string array", async () => {
    resetMemoState();
    const result = paths(glob({ root: "rules/imp", include: ["*.js"] }));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length > 0).toBe(true);
    expect(typeof result[0]).toBe("string");
});

test("paths(glob(...)) supports double-star patterns", async () => {
    resetMemoState();
    const result = paths(glob({ root: "rules", include: ["**/*_test.js"] }));
    expect(result).toContain("rules/imp/file_set_test.js");
});

test("paths(glob(...)) result is sorted", async () => {
    resetMemoState();
    const result = paths(glob({ root: "rules/imp", include: ["*.js"] }));
    const sorted = result.slice().sort();
    expect(result).toEqual(sorted);
});

test("file_set.union() returns a union FileSet", async () => {
    const a = glob({ root: "rules/imp", include: ["*_test.js"] });
    const b = glob({ root: "rules/imp", include: ["*.js"] });
    const u = file_set.union(a, b);
    expect(u.__fileset).toBe(true);
    expect(u.kind).toBe("union");
    expect(u.sets.length).toBe(2);
});

test("paths(file_set.union(a, b)) is deduplicated and sorted", async () => {
    const a = glob({ root: "rules/imp", include: ["*_test.js"] });
    const b = glob({ root: "rules/imp", include: ["*.js"] });
    const result = paths(file_set.union(a, b));
    const unique = [...new Set(result)];
    expect(result.length).toBe(unique.length);
    expect(result).toEqual(result.slice().sort());
});

test("paths(file_set.union(a, b)) contains paths from both sets", async () => {
    const a = glob({ root: "rules/imp", include: ["*memo*.js"] });
    const b = glob({ root: "rules/imp", include: ["*product*.js"] });
    const from_a = paths(a);
    const from_b = paths(b);
    const union_result = paths(file_set.union(a, b));
    for (const p of from_a) expect(union_result).toContain(p);
    for (const p of from_b) expect(union_result).toContain(p);
});

test("file_set.literal() returns a literal FileSet", async () => {
    const fs = file_set.literal(["b.js", "a.js"]);
    expect(fs.__fileset).toBe(true);
    expect(fs.kind).toBe("literal");
});

test("paths(file_set.literal([...])) returns sorted paths", async () => {
    const result = paths(file_set.literal(["b.js", "a.js", "c.js"]));
    expect(result).toEqual(["a.js", "b.js", "c.js"]);
});

test("paths() throws on a plain string", async () => {
    let threw = false;
    try {
        paths("not-a-fileset");
    } catch (e) {
        threw = true;
        expect(e.message).toContain("FileSet");
    }
    expect(threw).toBe(true);
});

test("file_set.union() throws if given a non-FileSet value", async () => {
    let threw = false;
    try {
        file_set.union(glob({ root: ".", include: ["**/*"] }), "not-a-fileset");
    } catch (e) {
        threw = true;
        expect(e.message).toContain("FileSet");
    }
    expect(threw).toBe(true);
});

test("memo wrapping paths(glob(...)) deduplicates correctly", async () => {
    resetMemoState();
    let calls = 0;
    const fn_ = memo(async function scan() {
        calls++;
        return paths(glob({ root: "rules/imp", include: ["*.js"] }));
    });
    const a = await fn_();
    const b = await fn_();
    expect(calls).toBe(1);
    expect(a).toEqual(b);
});

});
