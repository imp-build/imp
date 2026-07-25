import { describe, expect, test } from "//rules/imp/test";
import { pythonResolve, pythonResolveSyncArgs } from "//rules/python/resolve";

describe("python resolve", () => {
	test("uses the default flavor without reading the python mode", () => {
		const resolve = pythonResolve({
			path: "rules/python/example",
			flavors: { default: { extra: "cpu" } },
		});

		expect(resolve.kind).toBe("python-resolve");
		expect(pythonResolveSyncArgs(resolve)).toEqual(["--extra", "cpu"]);
	});

	test("requires a default flavor and rejects unknown flavor settings", () => {
		expect(() => pythonResolve({ flavors: { cpu: { extra: "cpu" } } })).toThrow(
			"default flavor",
		);
		expect(() =>
			pythonResolve({ flavors: { default: { extras: ["cpu"] } } }),
		).toThrow("only supports");
	});
});
