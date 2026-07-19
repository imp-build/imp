import { describe, expect, test, withFakeRun } from "//rules/imp/test";
import {
	env,
	which,
	glob,
	paths,
	read_file,
	run,
	output,
	getMemoTrace,
	memo,
	workspace_mutation,
	configure,
	configuration,
} from "imp:core";

describe("tracked runtime APIs", () => {
	test("env returns a string for PATH", async () => {
		const val = env("PATH");
		expect(typeof val).toBe("string");
	});

	test("env returns null for an unset variable", async () => {
		const val = env("__IMP_DEFINITELY_UNSET_VAR_12345");
		expect(val).toBe(null);
	});

	test("env records an effect entry in memo trace", async () => {
		env("PATH");
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) => t.event === "effect" && t.kind === "env",
		);
		expect(effects.length).toBe(1);
		expect(effects[0].name).toBe("PATH");
	});

	test("which returns a string path for sh", async () => {
		const p = which("sh");
		expect(typeof p).toBe("string");
	});

	test("which returns null for a nonexistent binary", async () => {
		const p = which("__imp_no_such_binary_xyz");
		expect(p).toBe(null);
	});

	test("which records an effect entry in memo trace", async () => {
		which("sh");
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) => t.event === "effect" && t.kind === "which",
		);
		expect(effects.length).toBe(1);
		expect(effects[0].name).toBe("sh");
	});

	test("configuration returns configured workspace values", async () => {
		configure("tracked_apis_test", null);
		configure("tracked_apis_test", {
			mode: "debug",
			nested: { enabled: true },
		});
		configure("tracked_apis_test", { nested: { level: 2 } });

		const cfg = configuration("tracked_apis_test", {});
		expect(cfg.mode).toBe("debug");
		expect(cfg.nested.enabled).toBe(true);
		expect(cfg.nested.level).toBe(2);
	});

	test("workspace configuration changes memo identity", async () => {
		configure("tracked_apis_memo_test", null);

		let calls = 0;
		const fn_ = memo(async function configured_value() {
			calls++;
			const cfg = configuration("tracked_apis_memo_test", {}) || {};
			return cfg.value || 0;
		});

		expect(await fn_()).toBe(0);
		expect(await fn_()).toBe(0);
		configure("tracked_apis_memo_test", { value: 7 });
		expect(await fn_()).toBe(7);
		expect(calls).toBe(2);
	});

	test("paths(glob(...)) returns an array of strings", async () => {
		const files = paths(glob({ root: "rules/imp", include: ["*.js"] }));
		expect(Array.isArray(files)).toBe(true);
		expect(files.length > 0).toBe(true);
		expect(typeof files[0]).toBe("string");
	});

	test("paths(glob(...)) records a paths effect entry in memo trace", async () => {
		paths(glob({ root: "rules/imp", include: ["*.js"] }));
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) => t.event === "effect" && t.kind === "paths",
		);
		expect(effects.length).toBe(1);
		expect(effects[0].fileset_kind).toBe("glob");
	});

	test("run executes a command and returns exitCode 0", async () => {
		const result = await run({ argv: ["sh", "-c", "echo hello"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	test("run records an effect entry in memo trace", async () => {
		await run({ argv: ["sh", "-c", "true"], display: "test-run" });
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) => t.event === "effect" && t.kind === "run",
		);
		expect(effects.length).toBe(1);
		expect(effects[0].display).toBe("test-run");
	});

	test("memo calling env still deduplicates on repeated calls", async () => {
		let calls = 0;
		const fn_ = memo(async function read_env() {
			calls++;
			return env("PATH");
		});
		await fn_();
		await fn_();
		expect(calls).toBe(1);
	});

	test("read_file reads a file written by run", async () => {
		const tmpfile = "/tmp/imp_tracked_test_" + Date.now() + ".txt";
		await run({ argv: ["sh", "-c", `echo tracked > ${tmpfile}`] });
		const content = read_file(tmpfile);
		expect(content.trim()).toBe("tracked");
	});

	test("withFakeRun: run() resolves without executing and still traces", async () => {
		const realHostRun = globalThis.__host_run;
		const result = await withFakeRun(() =>
			run({
				argv: ["sh", "-c", "exit 99"],
				display: "should-not-run",
				outputs: [output("fake/out.txt")],
				materialize: true,
			}),
		);
		expect(result.exitCode).toBe(0);
		expect(result.outputs).toEqual([{ kind: "file", path: "fake/out.txt" }]);
		expect(globalThis.__host_run).toBe(realHostRun);
		const { trace } = getMemoTrace();
		const effects = trace.filter(
			(t) => t.event === "effect" && t.kind === "run",
		);
		expect(effects.length).toBe(1);
		expect(effects[0].display).toBe("should-not-run");
	});

	// Regression test for #11: two concurrent run() calls with byte-identical
	// opts (the shape of the real race — e.g. rules/rust/test.js's
	// buildTestBinaries, called with different Target handles by sibling
	// rustTestBuild products for the same crate, producing identical run()
	// payloads that the Rust task cache has no lock between check and write
	// for) must coalesce onto one execution instead of both racing.
	test("run() single-flights concurrent calls with identical opts", async () => {
		const marker = "/tmp/imp_run_single_flight_test_" + Date.now() + ".txt";
		const opts = () => ({
			argv: [
				"sh",
				"-c",
				`printf r >> '${marker}' && sleep 0.3 && printf %s $$`,
			],
			display: "single-flight test",
		});

		const [a, b] = await Promise.all([run(opts()), run(opts())]);

		const fs_read = read_file(marker);
		expect(fs_read).toBe("r");
		expect(a.stdout).toBe(b.stdout);
	});

	test("getMemoTrace includes key_display with function name", async () => {
		let calls = 0;
		const fn_ = memo(async function my_fn() {
			calls++;
			return 42;
		});
		await fn_();
		const { key_display } = getMemoTrace();
		const labels = Object.values(key_display);
		expect(labels.some((l) => l.startsWith("my_fn("))).toBe(true);
	});

	test("memo cycle errors include a readable call chain", async () => {
		let first;
		let second;
		first = memo(async function first_cycle() {
			return second();
		});
		second = memo(async function second_cycle() {
			return first();
		});

		let message = "";
		try {
			await first();
		} catch (error) {
			message = error && error.message ? error.message : String(error);
		}

		expect(message).toContain("memo cycle detected:");
		expect(message).toContain("first_cycle()");
		expect(message).toContain("second_cycle()");
		expect(message).toContain("repeated key:");
	});

	test("workspace_mutation with watch reports changed files", async () => {
		// Use a fixed name so the regex pattern is simple; clean up before starting.
		const name = "imp_watch_test.tmp";
		await workspace_mutation({ argv: ["sh", "-c", `rm -f ${name}`] });
		const result = await workspace_mutation({
			argv: ["sh", "-c", `echo hello > ${name}`],
			watch: ["imp_watch_test\\.tmp"],
			display: "create watch test file",
		});
		await workspace_mutation({ argv: ["sh", "-c", `rm -f ${name}`] });
		expect(Array.isArray(result.changed_files)).toBe(true);
		expect(
			result.changed_files.some((f) => f.includes("imp_watch_test.tmp")),
		).toBe(true);
		const { trace } = getMemoTrace();
		const mut = trace.find(
			(t) =>
				t.kind === "workspace_mutation" &&
				t.display === "create watch test file",
		);
		expect(Array.isArray(mut.changed_files)).toBe(true);
	});
});
