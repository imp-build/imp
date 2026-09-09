import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetNasmToolchainStateForTest,
	nasmArtifactName,
	nasmDownloadUrl,
	nasmGraphTool,
	nasmHostBin,
	nasmToolchain,
} from "//rules/c/msvc";

// NASM ships a Windows x86_64 build only; every case runs on that platform.
function withNasmHost(fn) {
	return withFakeToolchainHost(
		{ os: "windows", arch: "x86_64" },
		async (host) => {
			__resetNasmToolchainStateForTest();
			try {
				return await fn(host);
			} finally {
				__resetNasmToolchainStateForTest();
			}
		},
	);
}

describe("NASM toolchain", () => {
	test("nasmArtifactName / nasmDownloadUrl follow the nasm.us release layout", () => {
		const plat = { os: "windows", arch: "x86_64" };
		expect(nasmArtifactName("3.02", plat)).toBe("nasm-3.02-win64.zip");
		expect(nasmDownloadUrl("3.02", plat)).toBe(
			"https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip",
		);
	});

	test("graph construction does not touch host run()", () => {
		return withNasmHost((host) => {
			nasmToolchain("3.02", { default: true });
			nasmGraphTool("3.02");
			expect(host.runs.length).toBe(0);
		});
	});
});

describe("NASM workspace lockfile selection", () => {
	const BUNDLED = "//rules/c/msvc/nasm.lock";

	function nasmLock(version, sha256) {
		return JSON.stringify({
			tool: "nasm",
			versions: {
				[version]: {
					"windows/x86_64": {
						url: "https://locked.example/nasm.zip",
						artifact: "nasm.zip",
						size: 42,
						sha256,
					},
				},
			},
		});
	}

	const readAddresses = (host) =>
		host.calls.filter((c) => c[0] === "readAddressedFile").map((c) => c[1]);

	test("the bundled lockfile is the default", async () => {
		await withNasmHost(async (host) => {
			host.addFile(BUNDLED, nasmLock("3.02", "cafe"));
			nasmToolchain("3.02", { default: true });

			await nasmHostBin("3.02");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withNasmHost(async (host) => {
			host.addFile("//locks/nasm.lock", nasmLock("3.02", "beef"));
			nasmToolchain("3.02", { default: true, lockfile: "//locks/nasm.lock" });

			await nasmHostBin("3.02");

			expect(readAddresses(host)).toContain("//locks/nasm.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withNasmHost(async () => {
			nasmToolchain("3.02", { default: true, lockfile: "//locks/nasm.lock" });
			let message = null;
			try {
				await nasmHostBin("3.02");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/nasm.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withNasmHost(() => {
			expect(() =>
				nasmToolchain("3.02", { lockfile: "locks/nasm.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withNasmHost(async (host) => {
			const toolchain = nasmToolchain("3.02", {
				default: true,
				lockfile: "//locks/nasm.lock",
			});
			await host.resolve(toolchain[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/nasm.lock")).toBe(
				true,
			);
		});
	});
});
