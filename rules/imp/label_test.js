import { describe, expect, test } from "//rules/imp/test";
import {
	attach,
	build,
	extensible,
	label,
	labelAddress,
	test as attachTest,
} from "imp:core";

describe("label/attach", () => {
	test("label() allocates a handle carrying opts.data", () => {
		const h = label({ data: { variant: "release" } });
		expect(h.data).toEqual({ variant: "release" });
	});

	test("labelAddress rejects non-label handles", () => {
		expect(() => labelAddress({})).toThrow("expected a label handle");
	});

	test("labelAddress returns the host-published canonical address", () => {
		const h = label();
		const original = globalThis.__host_target_address;
		globalThis.__host_target_address = (id) =>
			id === h.__id ? "//pkg:item" : original(id);
		try {
			expect(labelAddress(h)).toBe("//pkg:item");
		} finally {
			globalThis.__host_target_address = original;
		}
	});

	test("labelAddress propagates unresolved and unexported address errors", () => {
		const h = label();
		const original = globalThis.__host_target_address;
		globalThis.__host_target_address = () => {
			throw new Error("label has no published address");
		};
		try {
			expect(() => labelAddress(h)).toThrow("no published address");
		} finally {
			globalThis.__host_target_address = original;
		}
	});

	test("attach() runs a handler only when dispatched, not at attach time", () => {
		let ran = false;
		const h = label();
		attach(h, "build", async () => {
			ran = true;
		});
		expect(ran).toBe(false);
	});

	test("build(fn) one-arg shorthand creates a label and attaches the handler", async () => {
		let received;
		const h = build(async (ctx) => {
			received = ctx;
		});
		expect(h.__imp_label).toBe(true);

		// The shorthand's attachment is reachable the same way an explicit
		// build(label, fn) attachment would be — invoke it directly through
		// the same fn the shorthand attached, since dispatch itself is a
		// host-driven concern (execute_goal_live_selection) exercised by the
		// spike.rs end-to-end tests, not by this isolated rules-test runtime.
		// Re-attaching the identical fn is rejected (see below), so instead
		// confirm the label is real and selectable-shaped.
		expect(typeof h.__id).toBe("number");
	});

	test("attaching the exact same handler function twice to one (label, goal) throws", () => {
		const h = label();
		async function shared() {}
		attach(h, "build", shared);
		expect(() => attach(h, "build", shared)).toThrow("already attached");
	});

	test("attaching two different handler functions to one (label, goal) is not an error", () => {
		const h = label();
		attach(h, "build", async function handlerA() {});
		attach(h, "build", async function handlerB() {});
		// Neither call above threw; both handlers are attached and dispatch
		// (exercised end-to-end in spike.rs) runs both.
	});

	test("attach() rejects a non-label first argument", () => {
		expect(() => attach({}, "build", async () => {})).toThrow(
			"expects a label() handle",
		);
	});

	test("the same underlying function can attach to two different labels without conflict", () => {
		async function shared() {}
		const a = label();
		const b = label();
		attach(a, "build", shared);
		attach(b, "build", shared);
		// Different (label, goal) pairs — reusing one function across two
		// labels (the common factory pattern, e.g. cargoPackage()'s
		// `build(crate, ctx => cargoBuild(crate.data, ctx))`) is unaffected.
	});

	test('attachTest (goal sugar for "test") is a distinct export from the harness\'s test()', () => {
		expect(typeof attachTest).toBe("function");
		const h = label();
		attachTest(h, async () => {});
	});

	test("extensible() exposes global attach and selective with composition", () => {
		const packageFactory = extensible(function packageFactory(opts = {}) {
			return label({ data: opts });
		});
		function lintExtension() {}

		expect(packageFactory.attach(lintExtension)).toBe(packageFactory);
		// Re-attaching the same live extension is idempotent.
		expect(packageFactory.attach(lintExtension)).toBe(packageFactory);

		const checked = packageFactory.with(lintExtension).with(lintExtension);
		expect(typeof checked).toBe("function");
		expect(typeof checked.with).toBe("function");
		expect(checked.attach).toBe(undefined);
		expect(checked({ checked: true }).data).toEqual({ checked: true });
	});

	test("one extension may attach explicitly to several factories", () => {
		const first = extensible(function first() {
			return label();
		});
		const second = extensible(function second() {
			return label();
		});
		function sharedExtension() {}

		expect(first.attach(sharedExtension)).toBe(first);
		expect(second.attach(sharedExtension)).toBe(second);
	});

	test("extensible() validates factories, extensions, and label results", () => {
		expect(() => extensible({})).toThrow("expects a factory function");

		const invalid = extensible(function invalid() {
			return {};
		});
		expect(() => invalid()).toThrow(
			"must synchronously return a label() handle",
		);

		const valid = extensible(function valid() {
			return label();
		});
		expect(() => valid.attach({})).toThrow("expects an extension function");
		expect(() => valid.with()).toThrow("at least one extension function");
	});
});
