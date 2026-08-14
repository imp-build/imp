import { graphTestGoal } from "//rules/workflows/test";
import { expect, test } from "//rules/imp/test";

test("graphTestGoal passes silently when every unit is ok", () => {
	// A thrown error here fails the test itself — no matcher needed.
	graphTestGoal([
		{ address: "//pkg:a", result: [{ name: "unit-a", ok: true }] },
		{ address: "//pkg:b", result: [{ name: "unit-b", ok: true }] },
	]);
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

test("graphTestGoal ignores roots with no units", () => {
	graphTestGoal([{ address: "//pkg:a", result: [] }]);
});
