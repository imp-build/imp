import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetPnpmToolchainStateForTest,
	defaultPnpmToolchain,
	defaultPnpmToolchainVersion,
	installPnpmToolchain,
	pnpmArtifactName,
	pnpmBin,
	pnpmCacheKey,
	pnpmDownloadUrl,
	pnpmStoreDirEnv,
	pnpmStoreDirTool,
	pnpmGenLockfiles,
	pnpmToolchain,
} from "//rules/js/pnpm/toolchain";

function withPnpmHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetPnpmToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetPnpmToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("pnpm toolchain", () => {
	test("declares a default pnpm toolchain", () => {
		return withPnpmHost((host) => {
			const toolchain = pnpmToolchain("11.13.0", { default: true });

			expect(toolchain.__imp_graph_handle).toBe(true);
			expect(defaultPnpmToolchainVersion()).toBe("11.13.0");
			expect(defaultPnpmToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "pnpm-toolchains",
				),
			).toBe(true);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "pnpm-store",
				),
			).toBe(true);
		});
	});

	test("computes artifact name and download URL per platform", () => {
		return withPnpmHost(() => {
			const plat = { os: "linux", arch: "x86_64" };
			expect(pnpmArtifactName("11.13.0", plat)).toBe("pnpm-linux-x64.tar.gz");
			expect(pnpmDownloadUrl("11.13.0", plat)).toBe(
				"https://github.com/pnpm/pnpm/releases/download/v11.13.0/pnpm-linux-x64.tar.gz",
			);
			expect(pnpmCacheKey("11.13.0", plat)).toBe("11.13.0/linux-x86_64");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withPnpmHost(async () => {
			pnpmToolchain("11.13.0");
			let message = null;
			try {
				await pnpmBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no pnpm toolchain version specified");
		});
	});

	test("installPnpmToolchain publishes a local toolchain into the named cache", async () => {
		await withPnpmHost(async () => {
			const key = pnpmCacheKey("11.13.0", { os: "linux", arch: "x86_64" });

			expect(installPnpmToolchain("11.13.0", "/tmp/pnpm")).toBe(
				`/cache/pnpm-toolchains/${key}`,
			);
		});
	});

	test("downloads, verifies, and extracts pnpm via two sandboxed runs when not cached, with no strip-components", async () => {
		await withPnpmHost(async (host) => {
			host.addFile(
				"//rules/js/pnpm/pnpm-toolchain.lock",
				JSON.stringify({
					tool: "pnpm-toolchain",
					versions: {
						"11.13.0": {
							"linux/x86_64": {
								url: "https://locked.example/pnpm-linux-x64.tar.gz",
								artifact: "pnpm-linux-x64.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);
			host.install("pnpm-store", "shared", "/tmp/pnpm-store");
			pnpmToolchain("11.13.0", { default: true });
			const key = pnpmCacheKey("11.13.0", { os: "linux", arch: "x86_64" });

			expect(await pnpmBin("11.13.0")).toBe(
				`/cache/pnpm-toolchains/${key}/pnpm`,
			);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/pnpm-linux-x64.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(extract.argv[2]).not.toContain("--strip-components");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withPnpmHost(async () => {
			pnpmToolchain("11.13.0", { default: true });
			let message = null;
			try {
				await pnpmBin("11.13.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("describes the store-dir tool mount and env export", () => {
		return withPnpmHost(() => {
			const tool = pnpmStoreDirTool();
			expect(tool.cache).toBe("pnpm-store");
			expect(tool.binDirs).toEqual([]);
			expect(pnpmStoreDirEnv()).toEqual([
				"npm_config_store_dir=.imp/tools/pnpm-store",
			]);
		});
	});

	test("has no darwin-x86_64 (Intel Mac) release artifact", () => {
		return withPnpmHost({ os: "macos", arch: "x86_64" }, () => {
			let message = null;
			try {
				pnpmArtifactName("11.13.0", { os: "macos", arch: "x86_64" });
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("unsupported pnpm toolchain platform");
		});
	});

	test("uses the windows artifact naming", () => {
		return withPnpmHost({ os: "windows", arch: "aarch64" }, () => {
			expect(
				pnpmArtifactName("11.13.0", { os: "windows", arch: "aarch64" }),
			).toBe("pnpm-win32-arm64.zip");
		});
	});
});

describe("pnpm workspace lockfile selection", () => {
	const BUNDLED = "//rules/js/pnpm/pnpm-toolchain.lock";

	function pnpmLock(version, sha256) {
		return JSON.stringify({
			tool: "pnpm-toolchain",
			versions: {
				[version]: {
					"linux/x86_64": {
						url: "https://locked.example/tool.tar.gz",
						artifact: "tool.tar.gz",
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
		await withPnpmHost(async (host) => {
			host.addFile(BUNDLED, pnpmLock("11.13.0", "cafe"));
			pnpmToolchain("11.13.0", { default: true });

			await pnpmBin("11.13.0");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withPnpmHost(async (host) => {
			host.addFile("//locks/pnpm.lock", pnpmLock("10.5.0", "beef"));
			pnpmToolchain("10.5.0", { default: true, lockfile: "//locks/pnpm.lock" });

			await pnpmBin("10.5.0");

			expect(readAddresses(host)).toContain("//locks/pnpm.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withPnpmHost(async () => {
			pnpmToolchain("10.5.0", { default: true, lockfile: "//locks/pnpm.lock" });
			let message = null;
			try {
				await pnpmBin("10.5.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/pnpm.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withPnpmHost(() => {
			expect(() =>
				pnpmToolchain("10.5.0", { lockfile: "locks/pnpm.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withPnpmHost(async (host) => {
			pnpmToolchain("10.5.0", { default: true, lockfile: "//locks/pnpm.lock" });
			await host.resolve(pnpmGenLockfiles("10.5.0")[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/pnpm.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withPnpmHost(async (host) => {
			pnpmToolchain("10.5.0", { default: true, lockfile: "//locks/pnpm.lock" });
			await host.resolve(
				pnpmGenLockfiles("10.5.0", { lockfile: "//other/pnpm.lock" })[
					GEN_LOCKFILES
				],
			);
			expect(host.runs.some((r) => r.display === "write other/pnpm.lock")).toBe(
				true,
			);
		});
	});
});
