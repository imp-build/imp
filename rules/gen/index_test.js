import { BUILD } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { stampFile } from "//rules/gen";

describe("generated-file rules", () => {
	test("stampFile returns an immutable artifact root", () => {
		const stamp = stampFile({
			output: "generated/example.txt",
			text: "hello",
		});

		expect(Object.isFrozen(stamp)).toBe(true);
		expect(stamp.file.__imp_graph_handle).toBe(true);
		expect(stamp[BUILD]).toBe(stamp.file);
	});

	test("stampFile reuses the same graph task for matching declarations", () => {
		const first = stampFile({ output: "generated/shared.txt", text: "same" });
		const second = stampFile({ output: "generated/shared.txt", text: "same" });

		expect(first.file).toBe(second.file);
	});
});
