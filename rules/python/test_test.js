import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { PythonTest, pythonTest, pythonTestRun } from "//rules/python/test";
import { pythonResolve } from "//rules/python/resolve";
import {
	__resetUvToolchainStateForTest,
	uvToolchain,
} from "//rules/python/uv_toolchain";

function withUvHost(fn) {
	const run = async (host) => {
		__resetUvToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetUvToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("python test", () => {
	test("pythonTestRun syncs via uv --locked then runs pytest scoped to src, impure", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const suite = new PythonTest({ src: "rules/python/example" });

			await pythonTestRun(suite);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv[0]).toBe("sh");
			expect(testRun.argv).toContain("rules/python/example");
			expect(testRun.argv[2]).toContain("uv sync");
			expect(testRun.argv[2]).toContain("--locked");
			expect(testRun.argv[2]).toContain("-m pytest");
			expect(testRun.outputs).toEqual([]);
			expect(testRun.impure).toBe(true);
		});
	});

	test("pythonTestRun selects the resolve flavor's uv extra", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const resolve = pythonResolve({
				path: "rules/python/example",
				flavors: { default: { extra: "cpu" }, cu124: { extra: "cu124" } },
			});
			const suite = pythonTest({ resolve });
			expect(suite.attrs.resolve).toBe(resolve);
			const original = globalThis.__host_configuration;
			globalThis.__host_configuration = (namespace) =>
				namespace === "imp.mode"
					? JSON.stringify({ python: "cu124" })
					: original(namespace);
			try {
				await pythonTestRun(suite);
			} finally {
				globalThis.__host_configuration = original;
			}

			expect(host.runs[host.runs.length - 1].argv[2]).toContain(
				"--extra' 'cu124'",
			);
			expect(host.runs[host.runs.length - 1].argv).toContain(
				"rules/python/example",
			);
		});
	});

	test("pythonTestRun forwards testArgs to pytest", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const suite = pythonTest({
				src: "rules/python/example",
				testArgs: ["-k", "hello"],
			});

			await pythonTestRun(suite);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv).toContain("-k");
			expect(testRun.argv).toContain("hello");
		});
	});
});
