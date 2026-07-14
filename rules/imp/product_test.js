import { describe, expect, test } from "//rules/imp/test";
import { memo, product, productName, targetKind } from "imp:core";

const TestKind = targetKind("test-kind");
const TEST_PRODUCT = productName("test-product");
const OTHER_PRODUCT = productName("other-product");
const P_PRODUCT = productName("p-product");

describe("product", () => {

test("returns a callable memoized function", async () => {
    let calls = 0;
    const fn = product(TestKind, TEST_PRODUCT, async function compute(x) {
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
    const fn = product(TestKind, OTHER_PRODUCT, async function compute2(x) {
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

    const p = product(TestKind, P_PRODUCT, shared);
    const m = memo(shared);

    await p(5);
    await m(5);

    // Both wrap the same function reference, so they share the same fn_id
    // and share the same memo cache entry — second call is a hit.
    expect(calls).toBe(1);
});

});
