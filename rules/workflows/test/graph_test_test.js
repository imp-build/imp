import { graphTestGoal } from "//rules/workflows/test";
import { expect, test } from "//rules/imp/test";

test("graphTestGoal returns a sorted PASS/FAIL report instead of throwing when every unit is ok", () => {
	const report = graphTestGoal([
		{ address: "//pkg:b", result: [{ name: "unit-b", ok: true }] },
		{ address: "//pkg:a", result: [{ name: "unit-a", ok: true }] },
	]);
	expect(report).toBe(
		"PASS //pkg:a unit-a\nPASS //pkg:b unit-b\ntest: 2/2 unit(s) passed",
	);
});

test("graphTestGoal aggregates failures across every selected root, not just the first", () => {
	expect(() =>
		graphTestGoal([
			{
				address: "//pkg:a",
				result: [{ name: "unit-a", ok: false, output: "boom a" }],
			},
			{
				address: "//pkg:b",
				result: [{ name: "unit-b", ok: false, output: "boom b" }],
			},
		]),
	).toThrow("//pkg:a unit-a");
	expect(() =>
		graphTestGoal([
			{
				address: "//pkg:a",
				result: [{ name: "unit-a", ok: false, output: "boom a" }],
			},
			{
				address: "//pkg:b",
				result: [{ name: "unit-b", ok: false, output: "boom b" }],
			},
		]),
	).toThrow("//pkg:b unit-b");
});

test("graphTestGoal reports a passing unit alongside a failing one from a different root", () => {
	expect(() =>
		graphTestGoal([
			{ address: "//pkg:a", result: [{ name: "unit-a", ok: true }] },
			{
				address: "//pkg:b",
				result: [{ name: "unit-b", ok: false, output: "boom" }],
			},
		]),
	).toThrow("//pkg:b unit-b");
});

test("graphTestGoal's failure report includes each failing unit's captured output", () => {
	expect(() =>
		graphTestGoal([
			{
				address: "//pkg:a",
				result: [{ name: "unit-a", ok: false, output: "assertion failed" }],
			},
		]),
	).toThrow("assertion failed");
});

test("graphTestGoal ignores roots with no units", () => {
	const report = graphTestGoal([{ address: "//pkg:a", result: [] }]);
	expect(report).toBe("test: 0/0 unit(s) passed");
});
