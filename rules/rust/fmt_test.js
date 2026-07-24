import {
	describe,
	expect,
	test,
	withFakeDiff,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoPackage } from "//rules/rust";
import { cargoFmt } from "//rules/rust/fmt";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";

function withRustHost(fn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("rust fmt", () => {
	test("cargoFmt check mode runs cargo fmt --check against the manifest", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoFmt(pkg, { check: true });

			const fmtRun = host.runs[host.runs.length - 1];
			expect(fmtRun.argv[0]).toBe("sh");
			expect(fmtRun.argv[2]).toContain("--check");
			expect(fmtRun.outputs).toEqual([]);
		});
	});

	test("cargoFmt write mode runs cargo fmt without --check and declares source outputs", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			// withFakeRun-backed hosts don't produce a real outputDigest, so
			// diffDigests needs a stubbed result — same pattern as
			// rules/odin/odinfmt/index_test.js.
			await withFakeDiff(
				[{ type: "modified", path: "rules/rust/example/src/main.rs" }],
				async () => {
					const result = await cargoFmt(pkg);
					expect(result.formatted).toBe(1);
				},
			);

			const fmtRun = host.runs[host.runs.length - 1];
			expect(fmtRun.argv[2]).not.toContain("--check");
			expect(Array.isArray(fmtRun.outputs)).toBe(true);
		});
	});
});
