import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoPackage } from "//rules/rust";
import { cargoClippy } from "//rules/rust/lint";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";
import {
	gccToolchain,
	__resetGccToolchainStateForTest,
} from "//rules/c/gcc/toolchain";

function withRustHost(fn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("rust lint", () => {
	test("cargoClippy runs cargo clippy with -D warnings against the manifest", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const result = await cargoClippy(pkg);

			expect(result.ok).toBe(true);
			const clippyRun = host.runs[host.runs.length - 1];
			expect(clippyRun.argv[0]).toBe("sh");
			expect(clippyRun.argv[2]).toContain("cargo clippy");
			expect(clippyRun.argv[2]).toContain("--no-deps");
			expect(clippyRun.argv[2]).toContain("-D warnings");
			expect(clippyRun.allowFailure).toBe(true);
		});
	});

	test("cargoClippy reports a nonzero exit as ok:false instead of throwing", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const originalRun = globalThis.__host_run;
			globalThis.__host_run = async (opts) => {
				host.runs.push(opts);
				return {
					stdout: "",
					stderr: "warning: unused variable\n",
					exitCode: 1,
				};
			};
			try {
				const result = await cargoClippy(pkg);
				expect(result.ok).toBe(false);
				expect(result.output).toContain("unused variable");
			} finally {
				globalThis.__host_run = originalRun;
			}
		});
	});
});
