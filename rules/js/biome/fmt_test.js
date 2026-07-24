import {
	describe,
	expect,
	test,
	withFakeDiff,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { jsSources } from "//rules/js";
import { biomeFmt } from "//rules/js/biome/fmt";
import {
	__resetBiomeToolchainStateForTest,
	biomeToolchain,
} from "//rules/js/biome_toolchain";

function withBiomeHost(fn) {
	const run = async (host) => {
		__resetBiomeToolchainStateForTest();
		// Cold acquires verify against the lockfile, so the fake host needs
		// a matching entry for the toolchain the tests declare.
		host.addFile(
			"//rules/js/biome-toolchain.lock",
			JSON.stringify({
				tool: "biome-toolchain",
				versions: {
					"2.5.4": {
						"linux/x86_64": {
							url: "https://locked.example/biome-linux-x64",
							artifact: "biome-linux-x64",
							size: 12345,
							sha256: "deadbeef",
						},
					},
				},
			}),
		);
		try {
			return await fn(host);
		} finally {
			__resetBiomeToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("js fmt", () => {
	test("biomeFmt check mode runs biome format without --write against the target's sources", async () => {
		await withBiomeHost(async (host) => {
			biomeToolchain("2.5.4", { default: true });
			const target = jsSources({ src: "rules/js/example" });

			await biomeFmt(target, { check: true });

			const fmtRun = host.runs[host.runs.length - 1];
			expect(fmtRun.argv[0]).toBe("biome");
			expect(fmtRun.argv).toContain("format");
			expect(fmtRun.argv).not.toContain("--write");
			expect(fmtRun.outputs).toEqual([]);
		});
	});

	test("biomeFmt write mode runs biome format --write and declares source outputs", async () => {
		await withBiomeHost(async (host) => {
			biomeToolchain("2.5.4", { default: true });
			const target = jsSources({ src: "rules/js/example" });

			// withFakeRun-backed hosts don't produce a real outputDigest, so
			// diffDigests needs a stubbed result — same pattern as
			// rules/python/fmt_test.js.
			await withFakeDiff(
				[{ type: "modified", path: "rules/js/example/src/hello.js" }],
				async () => {
					const result = await biomeFmt(target);
					expect(result.formatted).toBe(1);
				},
			);

			const fmtRun = host.runs[host.runs.length - 1];
			expect(fmtRun.argv).toContain("--write");
			expect(Array.isArray(fmtRun.outputs)).toBe(true);
		});
	});
});
