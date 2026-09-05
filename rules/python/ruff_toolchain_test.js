import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetRuffToolchainStateForTest,
	defaultRuffToolchain,
	defaultRuffToolchainVersion,
	installRuffToolchain,
	ruffArtifactName,
	ruffBin,
	ruffCacheKey,
	ruffDownloadUrl,
	ruffGenLockfiles,
	ruffToolchain,
} from "//rules/python/ruff_toolchain";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const BUNDLED_LOCKFILE = "//rules/python/ruff-toolchain.lock";

// A one-version, one-platform lock for the platform withFakeToolchainHost
// reports (linux/x86_64). The sha is what the download argv is checked for,
// so each lock in a test gets its own.
function ruffLock(version, sha256) {
	return JSON.stringify({
		tool: "ruff-toolchain",
		versions: {
			[version]: {
				"linux/x86_64": {
					url: "https://locked.example/ruff.tar.gz",
					artifact: "ruff.tar.gz",
					size: 99,
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

function withRuffHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetRuffToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRuffToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("ruff toolchain", () => {
	test("declares a default ruff toolchain", () => {
		return withRuffHost((host) => {
			const toolchain = ruffToolchain("0.15.21", { default: true });

			expect(toolchain.__imp_graph_handle).toBe(true);
			expect(defaultRuffToolchainVersion()).toBe("0.15.21");
			expect(defaultRuffToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "ruff-toolchains",
				),
			).toBe(true);
		});
	});

	test("computes artifact name and download URL per platform", () => {
		return withRuffHost(() => {
			const plat = { os: "linux", arch: "x86_64" };
			expect(ruffArtifactName("0.15.21", plat)).toBe(
				"ruff-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(ruffDownloadUrl("0.15.21", plat)).toBe(
				"https://github.com/astral-sh/ruff/releases/download/0.15.21/ruff-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(ruffCacheKey("0.15.21", plat)).toBe("0.15.21/linux-x86_64");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withRuffHost(async () => {
			ruffToolchain("0.15.21");
			let message = null;
			try {
				await ruffBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no ruff toolchain version specified");
		});
	});

	test("installRuffToolchain publishes a local toolchain into the named cache", async () => {
		await withRuffHost(async () => {
			const key = ruffCacheKey("0.15.21", { os: "linux", arch: "x86_64" });

			expect(installRuffToolchain("0.15.21", "/tmp/ruff")).toBe(
				`/cache/ruff-toolchains/${key}`,
			);
		});
	});

	test("downloads, verifies, and extracts ruff via two sandboxed runs when not cached", async () => {
		await withRuffHost(async (host) => {
			host.addFile(
				"//rules/python/ruff-toolchain.lock",
				JSON.stringify({
					tool: "ruff-toolchain",
					versions: {
						"0.15.21": {
							"linux/x86_64": {
								url: "https://locked.example/ruff-x86_64-unknown-linux-gnu.tar.gz",
								artifact: "ruff-x86_64-unknown-linux-gnu.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);
			ruffToolchain("0.15.21", { default: true });
			const key = ruffCacheKey("0.15.21", { os: "linux", arch: "x86_64" });

			expect(await ruffBin("0.15.21")).toBe(
				`/cache/ruff-toolchains/${key}/ruff`,
			);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			// The lock entry pins both the URL and the expected digest.
			expect(download.argv).toContain(
				"https://locked.example/ruff-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.argv[2]).toContain("--strip-components=1");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withRuffHost(async () => {
			ruffToolchain("0.15.21", { default: true });
			let message = null;
			try {
				await ruffBin("0.15.21");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("unverified: true downloads without a sha check", async () => {
		await withRuffHost(async (host) => {
			ruffToolchain("0.15.21", { default: true, unverified: true });
			await ruffBin("0.15.21");

			expect(host.runs.length).toBe(2);
			const [download] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/astral-sh/ruff/releases/download/0.15.21/ruff-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(download.argv[2]).not.toContain("sha256sum");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withRuffHost(async (host) => {
			host.addFile(
				"//locks/ruff.lock",
				JSON.stringify({
					tool: "ruff-toolchain",
					versions: {
						"0.15.22": {
							"linux/x86_64": {
								url: "https://locked.example/ruff.tar.gz",
								artifact: "ruff.tar.gz",
								size: 99,
								sha256: "cafe",
							},
						},
					},
				}),
			);
			ruffToolchain("0.15.22", {
				default: true,
				lockfile: "//locks/ruff.lock",
			});
			await ruffBin("0.15.22");

			expect(
				host.calls.some(
					(call) =>
						call[0] === "readAddressedFile" && call[1] === "//locks/ruff.lock",
				),
			).toBe(true);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("uses the windows target triple and archive extension", () => {
		return withRuffHost({ os: "windows", arch: "x86_64" }, () => {
			const plat = { os: "windows", arch: "x86_64" };
			expect(ruffArtifactName("0.15.21", plat)).toBe(
				"ruff-x86_64-pc-windows-msvc.zip",
			);
		});
	});

	test("the bundled lockfile is the default", async () => {
		await withRuffHost(async (host) => {
			host.addFile(BUNDLED_LOCKFILE, ruffLock("0.15.21", "cafe"));
			ruffToolchain("0.15.21", { default: true });

			await ruffBin("0.15.21");

			expect(readAddresses(host)).toContain(BUNDLED_LOCKFILE);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withRuffHost(async () => {
			ruffToolchain("0.15.22", {
				default: true,
				lockfile: "//locks/ruff.lock",
			});
			let message = null;
			try {
				await ruffBin("0.15.22");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/ruff.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withRuffHost(() => {
			expect(() =>
				ruffToolchain("0.15.22", { lockfile: "locks/ruff.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withRuffHost(async (host) => {
			ruffToolchain("0.15.22", {
				default: true,
				lockfile: "//locks/ruff.lock",
			});

			await host.resolve(ruffGenLockfiles()[GEN_LOCKFILES]);

			expect(host.runs.some((r) => r.display === "write locks/ruff.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withRuffHost(async (host) => {
			ruffToolchain("0.15.22", {
				default: true,
				lockfile: "//locks/ruff.lock",
			});

			await host.resolve(
				ruffGenLockfiles("0.15.22", { lockfile: "//other/ruff.lock" })[
					GEN_LOCKFILES
				],
			);

			expect(host.runs.some((r) => r.display === "write other/ruff.lock")).toBe(
				true,
			);
		});
	});
});
