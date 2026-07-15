import { describe, expect, test } from "//rules/imp/test";
import { memo, resetMemoState, getMemoTrace } from "imp:core";

describe("memo", () => {
	test("calls the underlying function once for identical args", async () => {
		let calls = 0;
		const fn = memo(async function double(x) {
			calls++;
			return x * 2;
		});

		const a = await fn(3);
		const b = await fn(3);

		expect(a).toBe(6);
		expect(b).toBe(6);
		expect(calls).toBe(1);
	});

	test("calls the underlying function again for different args", async () => {
		let calls = 0;
		const fn = memo(async function double(x) {
			calls++;
			return x * 2;
		});

		const a = await fn(3);
		const b = await fn(4);

		expect(a).toBe(6);
		expect(b).toBe(8);
		expect(calls).toBe(2);
	});

	test("wrapping the same function reference twice shares the cache", async () => {
		let calls = 0;
		async function add(x) {
			calls++;
			return x + 1;
		}
		const fa = memo(add);
		const fb = memo(add);

		await fa(1);
		await fb(1);

		expect(calls).toBe(1);
	});

	test("distinct function references have independent caches", async () => {
		let callsA = 0,
			callsB = 0;
		const fa = memo(async function f(x) {
			callsA++;
			return x;
		});
		const fb = memo(async function f(x) {
			callsB++;
			return x;
		});

		await fa(1);
		await fb(1);

		expect(callsA).toBe(1);
		expect(callsB).toBe(1);
	});

	test("detects direct self-call cycle", async () => {
		let memoized;
		memoized = memo(async function self() {
			return await memoized();
		});

		let threw = false;
		try {
			await memoized();
		} catch (e) {
			threw = true;
			expect(e.message).toContain("cycle");
		}
		expect(threw).toBe(true);
	});

	test("detects indirect cycle between two memos", async () => {
		let a, b;
		a = memo(async function a() {
			return await b();
		});
		b = memo(async function b() {
			return await a();
		});

		let threw = false;
		try {
			await a();
		} catch (e) {
			threw = true;
			expect(e.message).toContain("cycle");
		}
		expect(threw).toBe(true);
	});

	test("records hit and miss events in trace", async () => {
		const fn = memo(async function inc(x) {
			return x + 1;
		});

		await fn(5);
		await fn(5);
		await fn(6);

		const { trace } = getMemoTrace();
		const events = trace.map((t) => t.event);
		expect(events[0]).toBe("miss");
		expect(events[1]).toBe("hit");
		expect(events[2]).toBe("miss");
	});

	test("records dependency edges between nested memo calls", async () => {
		const inner = memo(async function inner(x) {
			return x + 1;
		});
		const outer = memo(async function outer(x) {
			return await inner(x);
		});

		await outer(7);

		const { deps } = getMemoTrace();
		expect(deps.length).toBe(1);
		expect(typeof deps[0].caller).toBe("string");
		expect(typeof deps[0].callee).toBe("string");
	});

	test("resetMemoState clears the memo table", async () => {
		let calls = 0;
		const fn = memo(async function counter() {
			calls++;
			return 42;
		});

		await fn();
		resetMemoState();
		await fn();

		expect(calls).toBe(2);
	});

	test("handles multiple args", async () => {
		let calls = 0;
		const fn = memo(async function add(a, b) {
			calls++;
			return a + b;
		});

		const r1 = await fn(1, 2);
		const r2 = await fn(1, 2);
		const r3 = await fn(2, 1);

		expect(r1).toBe(3);
		expect(r2).toBe(3);
		expect(r3).toBe(3);
		expect(calls).toBe(2);
	});

	test("handles no args", async () => {
		let calls = 0;
		const fn = memo(async function noargs() {
			calls++;
			return 99;
		});

		await fn();
		await fn();

		expect(calls).toBe(1);
	});
});
