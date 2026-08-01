import { describe, expect, test } from "//rules/imp/test";
import { getMemoTrace, memo, resetMemoState, target } from "imp:core";

// Stubs __host_target_address (same technique as label_test.js) to simulate
// specific target ids resolving to specific workspace addresses, without
// needing a real BUILD.js export — test files themselves are never
// address-scanned (see spike.rs's load_workspace, which only walks
// BUILD.js/imp.workspace.js), so this is the only way to exercise
// _stable_digest's "addressed" branch from a plain unit test.
function withStubbedAddress(addressesById, fn) {
	const original = globalThis.__host_target_address;
	globalThis.__host_target_address = (id) => {
		if (Object.prototype.hasOwnProperty.call(addressesById, id)) {
			return addressesById[id];
		}
		throw new Error(`no address for target id ${id}`);
	};
	try {
		return fn();
	} finally {
		globalThis.__host_target_address = original;
	}
}

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

	test("uses explicit compact display templates", async () => {
		const handle = target({ kind: "memo-display-test", attrs: {} });
		const fn = memo(async function display() {}, {
			display: "inspect {0}: {1}, {2}, {3}, {{literal}}",
			level: "debug",
		});

		await fn(handle, "value", [handle, handle], { large: "object" });

		const { key_display } = getMemoTrace();
		expect(Object.values(key_display)[0]).toContain(
			": value, [2 targets], {…}, {literal}",
		);
	});

	test("uses the name of an unaddressed named target in displays", async () => {
		const handle = target({
			kind: "memo-display-test",
			attrs: { name: "example-tool" },
		});
		const fn = memo(async function display() {}, {
			display: "tool {0}",
			level: "debug",
		});

		await fn(handle);

		const { key_display } = getMemoTrace();
		expect(Object.values(key_display)[0]).toBe("tool example-tool");
	});

	test("legacy display fallback compacts nested values", async () => {
		const fn = memo(async function legacy(value) {});

		await fn([{ deeply: { nested: true } }]);

		const { key_display } = getMemoTrace();
		expect(Object.values(key_display)[0]).toBe("legacy([1 items])");
	});

	test("rejects invalid display metadata", () => {
		let invalidLevel = false;
		try {
			memo(async function invalid() {}, {
				display: "invalid",
				level: "verbose",
			});
		} catch (error) {
			invalidLevel = error.message.includes("level must be one of");
		}
		expect(invalidLevel).toBe(true);

		let invalidTemplate = false;
		try {
			memo(async function invalid() {}, {
				display: "invalid {name}",
				level: "debug",
			});
		} catch (error) {
			invalidTemplate = error.message.includes("positional placeholder");
		}
		expect(invalidTemplate).toBe(true);
	});

	test("rejects a display placeholder for a missing argument", async () => {
		const fn = memo(async function missing() {}, {
			display: "missing {1}",
			level: "debug",
		});
		let threw = false;
		try {
			await fn("only");
		} catch (error) {
			threw = error.message.includes("missing argument {1}");
		}
		expect(threw).toBe(true);
	});

	// #58: stable label/target reference identity in persisted memo keys.
	// _stable_digest already implements the decided policy (exported handles
	// digest by workspace address; anonymous/dynamic handles are rejected
	// from persistence, never content-addressed as a substitute) — these
	// tests lock that behavior in, since nothing previously asserted on it.
	describe("stable label/target reference identity (#58)", () => {
		test("reordering unrelated target construction does not change an addressed handle's persisted key", async () => {
			const fn = memo(
				async function subjectFn(h) {
					return h.__id;
				},
				{ display: "subjectFn {0}", level: "debug" },
			);

			async function persistKeyFor(buildSubjectLast) {
				resetMemoState();
				const others = [
					target({ kind: "memo-stable-test", attrs: {} }),
					target({ kind: "memo-stable-test", attrs: {} }),
				];
				const subject = buildSubjectLast
					? (others.push(target({ kind: "memo-stable-test", attrs: {} })),
						others.pop())
					: target({ kind: "memo-stable-test", attrs: {} });
				const addresses = { [subject.__id]: "//pkg:subject" };
				for (const [i, h] of others.entries()) {
					addresses[h.__id] = `//pkg:other-${i}`;
				}
				return withStubbedAddress(addresses, async () => {
					await fn(subject);
					const { persist_keys } = getMemoTrace();
					return Object.values(persist_keys)[0];
				});
			}

			const keyConstructedFirst = await persistKeyFor(false);
			const keyConstructedLast = await persistKeyFor(true);

			expect(keyConstructedFirst).not.toBe(null);
			expect(keyConstructedFirst).toBe(keyConstructedLast);
		});

		test("an anonymous (unaddressed) handle disables persistence but not in-process reuse", async () => {
			resetMemoState();
			let calls = 0;
			const fn = memo(
				async function unaddressedFn(h) {
					calls++;
					return h.__id;
				},
				{ display: "unaddressedFn {0}", level: "debug" },
			);
			const anon = target({ kind: "memo-stable-test", attrs: {} });

			await fn(anon);
			await fn(anon);
			expect(calls).toBe(1); // in-process reuse still works

			const { persist_keys, trace } = getMemoTrace();
			expect(Object.values(persist_keys)[0]).toBe(null);
			expect(trace.some((e) => e.event === "memo-unaddressed-skip")).toBe(true);
		});

		test("link()/profile()-style overlay wrappers digest consistently for addressed handles and propagate unaddressed for anonymous ones", async () => {
			const fn = memo(
				async function overlayFn(h) {
					return h;
				},
				{ display: "overlayFn {0}", level: "debug" },
			);
			const addressed = target({ kind: "memo-stable-test", attrs: {} });
			const anon = target({ kind: "memo-stable-test", attrs: {} });

			// Constructed directly (bypassing link()/profile()'s mode-axis
			// validation, which needs real declared axes) to exercise
			// _stable_digest's own wrapper-unwrapping branch in isolation.
			const wrap = (handle) => ({
				__imp_profile: true,
				handle,
				profiles: ["release"],
				overrides: {},
			});

			resetMemoState();
			const key1 = await withStubbedAddress(
				{ [addressed.__id]: "//pkg:addressed" },
				async () => {
					await fn(wrap(addressed));
					return Object.values(getMemoTrace().persist_keys)[0];
				},
			);
			expect(key1).not.toBe(null);

			resetMemoState();
			const key2 = await withStubbedAddress(
				{ [addressed.__id]: "//pkg:addressed" },
				async () => {
					await fn(wrap(addressed));
					return Object.values(getMemoTrace().persist_keys)[0];
				},
			);
			expect(key2).toBe(key1);

			resetMemoState();
			await fn(wrap(anon));
			expect(Object.values(getMemoTrace().persist_keys)[0]).toBe(null);
		});

		test("resetMemoState() plus an independently-constructed, equivalently-addressed handle yields a persisted-cache hit", async () => {
			// rules-test sandboxes run with IMP_DISABLE_MEMO_CACHE=1 (see
			// rules/imp/test/index.js's test_product) so persisted records
			// from one test file's run never leak into another's call-count
			// assertions — real __host_memo_read/write are no-ops here. Stub
			// them directly (same technique as withStubbedAddress) with an
			// in-memory store, so this test exercises the real
			// _load_persisted_memo/_persist_memo_result/
			// _validate_persisted_memo_record logic under test, independent of
			// that sandbox-wide opt-out.
			const memoStore = new Map();
			const originalRead = globalThis.__host_memo_read;
			const originalWrite = globalThis.__host_memo_write;
			globalThis.__host_memo_read = (key) => memoStore.get(key);
			globalThis.__host_memo_write = (recordJson) => {
				const record = JSON.parse(recordJson);
				memoStore.set(record.key, recordJson);
			};

			try {
				resetMemoState();
				let calls = 0;
				const fn = memo(
					async function crossProcessFn(h) {
						calls++;
						return h.__id;
					},
					{ display: "crossProcessFn {0}", level: "debug" },
				);

				const handleA = target({ kind: "memo-stable-test", attrs: {} });
				await withStubbedAddress(
					{ [handleA.__id]: "//pkg:cross-process" },
					() => fn(handleA),
				);
				expect(calls).toBe(1);

				// Simulates a fresh process: clears the in-process table/trace,
				// but leaves persisted records (the fake store above) untouched
				// — resetMemoState() never touches __host_memo_read/write.
				resetMemoState();

				// A different object/id (as a separate process would allocate),
				// but the same stable workspace address.
				const handleB = target({ kind: "memo-stable-test", attrs: {} });
				await withStubbedAddress(
					{ [handleB.__id]: "//pkg:cross-process" },
					() => fn(handleB),
				);

				// The persisted record from the first call is keyed on the
				// address, not the process-local __id, so the underlying fn
				// must not re-run.
				expect(calls).toBe(1);
				const { trace } = getMemoTrace();
				expect(trace.some((e) => e.event === "persisted-hit")).toBe(true);
			} finally {
				globalThis.__host_memo_read = originalRead;
				globalThis.__host_memo_write = originalWrite;
			}
		});
	});
});
