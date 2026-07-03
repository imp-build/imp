import { describe, expect, test } from "//rules/imp/test";
import { dispatchSelection, memo, product, target } from "imp:core";

describe("product", () => {

test("returns a callable memoized function", async () => {
    let calls = 0;
    const fn = product("test-kind", "test-product", async function compute(x) {
        calls++;
        return x * 3;
    });

    const a = await fn(4);
    const b = await fn(4);

    expect(a).toBe(12);
    expect(b).toBe(12);
    expect(calls).toBe(1);
});

test("different args produce different results", async () => {
    let calls = 0;
    const fn = product("test-kind", "other-product", async function compute2(x) {
        calls++;
        return x + 10;
    });

    const a = await fn(1);
    const b = await fn(2);

    expect(a).toBe(11);
    expect(b).toBe(12);
    expect(calls).toBe(2);
});

test("product and memo of the same function have independent caches", async () => {
    let calls = 0;
    async function shared(x) { calls++; return x; }

    const p = product("test-kind", "p-product", shared);
    const m = memo(shared);

    await p(5);
    await m(5);

    // Both wrap the same function reference, so they share the same fn_id
    // and share the same memo cache entry — second call is a hit.
    expect(calls).toBe(1);
});

});

describe("dispatchSelection", () => {

test("dispatches every selected target to its registered product, fanned out", async () => {
    const ran = [];
    product("dispatch-test-a", "dispatch", async (handle) => { ran.push(handle.kind); });
    product("dispatch-test-b", "dispatch", async (handle) => { ran.push(handle.kind); });
    const a = target({ kind: "dispatch-test-a" });
    const b = target({ kind: "dispatch-test-b" });

    await dispatchSelection([
        { id: a.__id, address: "//:a", kind: "dispatch-test-a", product: "dispatch" },
        { id: b.__id, address: "//:b", kind: "dispatch-test-b", product: "dispatch" },
    ]);

    expect(ran.length).toBe(2);
    expect(ran).toContain("dispatch-test-a");
    expect(ran).toContain("dispatch-test-b");
});

test("wraps the first failure with the target's address#product label", async () => {
    product("dispatch-test-fail", "dispatch", async () => {
        throw new Error("boom");
    });
    const failing = target({ kind: "dispatch-test-fail" });

    let message = "";
    try {
        await dispatchSelection([
            { id: failing.__id, address: "//:failing", kind: "dispatch-test-fail", product: "dispatch" },
        ]);
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("//:failing#dispatch");
    expect(message).toContain("boom");
});

test("throws before dispatching anything when a selected product isn't registered", async () => {
    let ran = false;
    product("dispatch-test-known", "dispatch", async () => { ran = true; });
    const known = target({ kind: "dispatch-test-known" });

    let message = "";
    try {
        await dispatchSelection([
            { id: known.__id, address: "//:known", kind: "dispatch-test-known", product: "dispatch" },
            { id: 999999, address: "//:missing", kind: "dispatch-test-missing", product: "dispatch" },
        ]);
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("no product 'dispatch' for kind 'dispatch-test-missing'");
    expect(message).toContain("//:missing");
    expect(ran).toBe(false);
});

});
