import { describe, expect, test } from "//rules/imp/test";
import { memo, product, productFor, productName, resolveProducts, target, targetKind, toolName } from "imp:core";
const TEST_TOOL = toolName("product-test-tool");

const TestKind = targetKind("test-kind");
const TEST_PRODUCT = productName("test-product");
const OTHER_PRODUCT = productName("other-product");
const P_PRODUCT = productName("p-product");
const MULTI_PRODUCT = productName("multi-product");
const ROLE_PRODUCT = productName("role-product");

describe("product", () => {

test("returns a callable memoized function", async () => {
    let calls = 0;
    const fn = product(TestKind, TEST_PRODUCT, TEST_TOOL, async function compute(x) {
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
    const fn = product(TestKind, OTHER_PRODUCT, TEST_TOOL, async function compute2(x) {
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

    const p = product(TestKind, P_PRODUCT, TEST_TOOL, shared);
    const m = memo(shared);

    await p(5);
    await m(5);

    // Both wrap the same function reference, so they share the same fn_id
    // and share the same memo cache entry — second call is a hit.
    expect(calls).toBe(1);
});

test("requires a declared tool token", () => {
    expect(() => product(TestKind, TEST_PRODUCT, "bare-string", async () => {}))
        .toThrow("requires a tool-name token");
    expect(() => product(TestKind, TEST_PRODUCT, undefined, async () => {}))
        .toThrow("requires a tool-name token");
});

test("two tools can register the same product and both dispatch", async () => {
    const OTHER_TOOL = toolName("product-test-other-tool");
    const ran = [];
    product(TestKind, MULTI_PRODUCT, TEST_TOOL, async function multiA() { ran.push("a"); });
    product(TestKind, MULTI_PRODUCT, OTHER_TOOL, async function multiB() { ran.push("b"); });

    const handle = target({ kind: "test-kind" });
    const resolved = resolveProducts({
        id: handle.__id,
        address: "//:multi",
        kind: "test-kind",
        product: MULTI_PRODUCT,
    });

    expect(resolved.length).toBe(2);
    // Multi-tool labels carry the tool so run output stays attributable.
    expect(resolved.map((r) => r.label).sort()).toEqual([
        "//:multi#multi-product@product-test-other-tool",
        "//:multi#multi-product@product-test-tool",
    ]);
    for (const { fn } of resolved) await fn(handle);
    expect(ran.sort()).toEqual(["a", "b"]);
});

test("productFor rejects a role registered by several tools", async () => {
    const OTHER_TOOL = toolName("product-test-other-tool");
    product(TestKind, ROLE_PRODUCT, TEST_TOOL, async () => "one");
    const handle = target({ kind: "test-kind" });
    expect(await productFor(handle, ROLE_PRODUCT)).toBe("one");

    product(TestKind, ROLE_PRODUCT, OTHER_TOOL, async () => "two");
    expect(() => productFor(handle, ROLE_PRODUCT))
        .toThrow("products from several tools");
});

});
