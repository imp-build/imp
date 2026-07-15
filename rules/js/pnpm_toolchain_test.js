import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetPnpmToolchainStateForTest,
	acquirePnpmToolchain,
	defaultPnpmToolchain,
	defaultPnpmToolchainVersion,
	installPnpmToolchain,
	pnpmArtifactName,
	pnpmBin,
	pnpmCacheKey,
	pnpmDownloadUrl,
	pnpmStoreDirEnv,
	pnpmStoreDirTool,
	pnpmTool,
	pnpmToolchain,
} from "//rules/js/pnpm_toolchain";

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

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("11.13.0");
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

	test("throws when no toolchain has been declared", async () => {
		await withPnpmHost(async () => {
			let message = null;
			try {
				await acquirePnpmToolchain("11.13.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no pnpm toolchain declared");
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

	test("installs and acquires a toolchain from the named cache, seeding the store on first acquire", async () => {
		await withPnpmHost(async (host) => {
			const key = pnpmCacheKey("11.13.0", { os: "linux", arch: "x86_64" });

			const seeded = installPnpmToolchain("11.13.0", "/tmp/pnpm");
			expect(seeded).toBe(`/cache/pnpm-toolchains/${key}`);

			pnpmToolchain("11.13.0", { default: true });
			expect(await acquirePnpmToolchain("11.13.0")).toBe(
				`/cache/pnpm-toolchains/${key}`,
			);
			expect(await pnpmBin("11.13.0")).toBe(
				`/cache/pnpm-toolchains/${key}/pnpm`,
			);
			// Toolchain itself is warm (installPnpmToolchain seeded it), but the
			// shared pnpm-store cache has never been seeded, so one run() should
			// have happened to create it.
			expect(host.runs.length).toBe(1);
			expect(host.runs[0].outputs[0].namedCache.name).toBe("pnpm-store");
		});
	});

	test("skips the store seed run when the store is already warm", async () => {
		await withPnpmHost(async (host) => {
			installPnpmToolchain("11.13.0", "/tmp/pnpm");
			host.install("pnpm-store", "shared", "/tmp/pnpm-store");
			pnpmToolchain("11.13.0", { default: true });

			await acquirePnpmToolchain("11.13.0");
			expect(host.runs.length).toBe(0);
		});
	});

	test("downloads, verifies, and extracts pnpm via two sandboxed runs when not cached, with no strip-components", async () => {
		await withPnpmHost(async (host) => {
			host.addFile(
				"//rules/js/pnpm-toolchain.lock",
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
			const tool = await pnpmTool("11.13.0");

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("pnpm");
			expect(tool.binDirs).toEqual(["."]);
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
				await pnpmTool("11.13.0");
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
