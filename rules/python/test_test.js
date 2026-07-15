import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { PythonTest, pythonTest, pythonTestRun } from "//rules/python/test";
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
	test("pythonTestRun syncs via uv --frozen then runs pytest scoped to src, impure", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const suite = new PythonTest({ src: "rules/python/example" });

			await pythonTestRun(suite);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv[0]).toBe("sh");
			expect(testRun.argv).toContain("rules/python/example");
			expect(testRun.argv[2]).toContain("uv sync");
			expect(testRun.argv[2]).toContain("--frozen");
			expect(testRun.argv[2]).toContain("-m pytest");
			expect(testRun.outputs).toEqual([]);
			expect(testRun.impure).toBe(true);
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
