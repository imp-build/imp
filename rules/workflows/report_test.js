import { statusReport } from "//rules/workflows/report";
import { expect, test } from "//rules/imp/test";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const opts = {
	order: ["failed", "changed", "unchanged"],
	colors: { failed: "red", changed: "yellow", unchanged: "green" },
	summary: (counts) =>
		`fmt: ${counts.unchanged} unchanged, ${counts.changed} changed, ${counts.failed} failed`,
};

test("statusReport sorts by status severity, then by key", () => {
	const report = statusReport(
		[
			{ key: "//pkg:z", status: "unchanged" },
			{ key: "//pkg:a", status: "changed" },
			{ key: "//pkg:m", status: "failed" },
			{ key: "//pkg:b", status: "failed" },
		],
		opts,
	);
	const lines = report.split("\n");
	expect(lines[0]).toContain("//pkg:b");
	expect(lines[1]).toContain("//pkg:m");
	expect(lines[2]).toContain("//pkg:a");
	expect(lines[3]).toContain("//pkg:z");
});

test("statusReport aligns the key column to the longest key", () => {
	const report = statusReport(
		[
			{ key: "//pkg:short", status: "unchanged" },
			{ key: "//pkg:a-much-longer-address", status: "unchanged" },
		],
		opts,
	);
	const width = "//pkg:a-much-longer-address".length + 2;
	expect(report.split("\n")[0]).toBe(
		`${"//pkg:a-much-longer-address".padEnd(width)}${GREEN}UNCHANGED${RESET}`,
	);
});

test("statusReport colors each status per the given palette", () => {
	const report = statusReport(
		[
			{ key: "//pkg:a", status: "failed" },
			{ key: "//pkg:b", status: "changed" },
			{ key: "//pkg:c", status: "unchanged" },
		],
		opts,
	);
	expect(report).toContain(`${RED}FAILED${RESET}`);
	expect(report).toContain(`${YELLOW}CHANGED${RESET}`);
	expect(report).toContain(`${GREEN}UNCHANGED${RESET}`);
});

test("statusReport appends output blocks only for units that have one", () => {
	const report = statusReport(
		[
			{ key: "//pkg:a", status: "failed", output: "diagnostic detail" },
			{ key: "//pkg:b", status: "unchanged" },
		],
		opts,
	);
	expect(report).toContain("//pkg:a:\ndiagnostic detail");
	expect(report.includes("//pkg:b:\n")).toBe(false);
});

test("statusReport calls summary with per-status counts", () => {
	const report = statusReport(
		[
			{ key: "//pkg:a", status: "failed" },
			{ key: "//pkg:b", status: "changed" },
			{ key: "//pkg:c", status: "unchanged" },
			{ key: "//pkg:d", status: "unchanged" },
		],
		opts,
	);
	expect(report.split("\n").at(-1)).toBe(
		"fmt: 2 unchanged, 1 changed, 1 failed",
	);
});
