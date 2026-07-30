import { paths } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import {
	declared_path,
	js_file_sources,
	jsSources,
	jsSourcesActionHandle,
	sources,
} from "//rules/js";

function withPublishedAddress(handle, address, fn) {
	const original = globalThis.__host_target_address;
	globalThis.__host_target_address = (id) =>
		id === handle.__id ? address : original(id);
	try {
		return fn();
	} finally {
		globalThis.__host_target_address = original;
	}
}

describe("jsSources", () => {
	test("returns a label() handle carrying normalized src/deps", () => {
		const h = jsSources({ src: "./rules/js/example/", deps: [] });
		expect(h.__imp_label).toBe(true);
		expect(h.data.src).toBe("rules/js/example");
		expect(h.data.deps).toEqual([]);
	});

	test('defaults src to the declaring directory (".")', () => {
		const h = jsSources({});
		expect(h.data.src).toBe(".");
	});

	test("normalizes deps, keeping label() handles as well as legacy Target handles", () => {
		const otherLabel = jsSources({ src: "example" });
		const legacyTarget = { __imp: true };
		const wrapped = { target: legacyTarget };
		const h = jsSources({ deps: [otherLabel, legacyTarget, wrapped] });
		expect(h.data.deps).toEqual([otherLabel, legacyTarget, legacyTarget]);
	});

	test("rejects paths that escape the workspace", () => {
		expect(() => jsSources({ src: "../outside" })).toThrow(
			"must stay within the workspace",
		);
	});

	test("jsSourcesActionHandle shims a raw label into {attrs, deps}", () => {
		const h = jsSources({ src: "rules/js/example" });
		const handle = jsSourcesActionHandle(h);
		expect(handle.label).toBe(h);
		expect(handle.attrs).toBe(h.data);
		expect(handle.attrs.src).toBe("rules/js/example");
	});

	test("jsSourcesActionHandle passes an already-shimmed handle through unchanged", () => {
		const h = jsSources({ src: "rules/js/example" });
		const once = jsSourcesActionHandle(h);
		const twice = jsSourcesActionHandle(once);
		expect(twice).toBe(once);
	});

	test("declared_path resolves the label's src relative to its declaring directory", () => {
		// //rules/js:whatever declares in "rules/js"; src "example" is
		// relative to that directory, same as a real BUILD.js at
		// rules/js/example declaring jsSources({ src: "src" }).
		const h = jsSources({ src: "example" });
		withPublishedAddress(h, "//rules/js:whatever", () => {
			expect(declared_path(h, h.data.src)).toBe("rules/js/example");
		});
	});

	test("sources() stays scoped to its own directory, including package.json", () => {
		const h = jsSources({ src: "example" });
		return withPublishedAddress(h, "//rules/js:whatever", async () => {
			const result = paths(await sources(h));
			expect(result).toContain("rules/js/example/package.json");
			// Single-directory glob only — src/'s files belong to the
			// separate jsSources({ src: "src" }) target in the same fixture,
			// not this one.
			expect(result).not.toContain("rules/js/example/src/hello.js");
		});
	});

	test("js_file_sources() omits the BUILD.js sandbox input that sources() would carry", () => {
		// js_file_sources' include list ends in "*.json", which still
		// matches package.json (a pre-existing quirk, unrelated to this
		// migration — see the //rules/js/index.js comment above the memo).
		// The two globs differ only in whether they include *.json at all;
		// there's no separately-scoped set that drops package.json by name.
		const h = jsSources({ src: "example" });
		return withPublishedAddress(h, "//rules/js:whatever", async () => {
			const result = paths(await js_file_sources(h));
			expect(result).toContain("rules/js/example/package.json");
		});
	});
});
