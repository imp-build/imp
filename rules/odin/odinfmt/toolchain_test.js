import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetOdinfmtToolchainStateForTest,
	odinfmtArtifactName,
	odinfmtBin,
	odinfmtGenLockfiles,
	odinfmtGraphTool,
	odinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";
import {
	__resetOdinToolchainStateForTest,
	odinToolchain,
} from "//rules/odin/toolchain";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const BUNDLED_LOCKFILE = "//rules/odin/odinfmt/odinfmt.lock";

// odinfmt pins itself to the Odin compiler version, so a host needs an Odin
// default declared before any odinfmt declaration resolves.
function withOdinfmtHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetOdinToolchainStateForTest();
		__resetOdinfmtToolchainStateForTest();
		odinToolchain("dev-2026-05", { default: true });
		host.clearCalls();
		host.runs.length = 0;
		try {
			return await fn(host);
		} finally {
			__resetOdinfmtToolchainStateForTest();
			__resetOdinToolchainStateForTest();
		}
	});
}

// A one-version, one-platform lock for the platform withFakeToolchainHost
// reports (linux/x86_64).
function odinfmtLock(version, sha256) {
	return JSON.stringify({
		tool: "odinfmt",
		versions: {
			[version]: {
				"linux/x86_64": {
					url: "https://locked.example/ols.zip",
					artifact: "ols.zip",
					size: 42,
					sha256,
				},
			},
		},
	});
}

function readAddresses(host) {
	return host.calls
		.filter((call) => call[0] === "readAddressedFile")
		.map((call) => call[1]);
}

describe("odinfmt graph toolchain", () => {
	test("declares verified graph tools", () => {
		expect(
			odinfmtArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toContain("ols-x86_64-unknown-linux-gnu.zip");
		expect(odinfmtToolchain("dev-2026-03").__imp_graph_handle).toBe(true);
		expect(odinfmtGraphTool("dev-2026-03").__imp_graph_handle).toBe(true);
	});

	test("the bundled lockfile is the default", async () => {
		await withOdinfmtHost(async (host) => {
			host.addFile(BUNDLED_LOCKFILE, odinfmtLock("dev-2026-05", "cafe"));
			odinfmtToolchain(undefined, { default: true });

			await odinfmtBin();

			expect(readAddresses(host)).toContain(BUNDLED_LOCKFILE);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withOdinfmtHost(async (host) => {
			host.addFile("//locks/odinfmt.lock", odinfmtLock("dev-2026-05", "beef"));
			odinfmtToolchain(undefined, {
				default: true,
				lockfile: "//locks/odinfmt.lock",
			});

			await odinfmtBin();

			expect(readAddresses(host)).toContain("//locks/odinfmt.lock");
			expect(readAddresses(host).includes(BUNDLED_LOCKFILE)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withOdinfmtHost(async () => {
			odinfmtToolchain(undefined, {
				default: true,
				lockfile: "//locks/odinfmt.lock",
			});
			let message = null;
			try {
				await odinfmtBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/odinfmt.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withOdinfmtHost(() => {
			expect(() =>
				odinfmtToolchain(undefined, { lockfile: "locks/odinfmt.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withOdinfmtHost(async (host) => {
			odinfmtToolchain(undefined, {
				default: true,
				lockfile: "//locks/odinfmt.lock",
			});

			await host.resolve(odinfmtGenLockfiles()[GEN_LOCKFILES]);

			expect(
				host.runs.some((r) => r.display === "write locks/odinfmt.lock"),
			).toBe(true);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withOdinfmtHost(async (host) => {
			odinfmtToolchain(undefined, {
				default: true,
				lockfile: "//locks/odinfmt.lock",
			});

			await host.resolve(
				odinfmtGenLockfiles(undefined, { lockfile: "//other/odinfmt.lock" })[
					GEN_LOCKFILES
				],
			);

			expect(
				host.runs.some((r) => r.display === "write other/odinfmt.lock"),
			).toBe(true);
		});
	});
});
