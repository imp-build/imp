import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetPexToolchainStateForTest,
	defaultPexToolchain,
	defaultPexToolchainVersion,
	installPexToolchain,
	pexBin,
	pexCacheKey,
	pexDownloadUrl,
	pexGenLockfiles,
	pexGraphTool,
	pexTool,
	pexToolchain,
} from "//rules/python/pex_toolchain";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const BUNDLED_LOCKFILE = "//rules/python/pex-toolchain.lock";

// pex publishes one platform-independent zipapp, so its lock entries key
// under the "any/any" pseudo-platform, not the linux/x86_64 that
// withFakeToolchainHost reports. The sha is what the download argv is
// checked for, so each lock in a test gets its own.
function pexLock(version, sha256) {
	return JSON.stringify({
		tool: "pex-toolchain",
		versions: {
			[version]: {
				"any/any": {
					url: "https://locked.example/pex",
					artifact: "pex",
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

function withPexHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetPexToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetPexToolchainStateForTest();
		}
	});
}

describe("pex toolchain", () => {
	test("keys the cache by version alone", () => {
		// pex ships one platform-independent zipapp, so no os/arch in the key.
		expect(pexCacheKey("2.97.1")).toBe("2.97.1");
		expect(pexDownloadUrl("2.97.1")).toBe(
			"https://github.com/pantsbuild/pex/releases/download/v2.97.1/pex",
		);
	});

	test("declares a default pex toolchain", () => {
		return withPexHost((host) => {
			const tool = pexToolchain("2.97.1", { default: true });

			expect(tool.__imp_graph_handle).toBe(true);
			expect(defaultPexToolchainVersion()).toBe("2.97.1");
			expect(defaultPexToolchain()).toBe(tool);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "pex-toolchains",
				),
			).toBe(true);
		});
	});

	test("installPexToolchain publishes a local zipapp into the named cache", async () => {
		await withPexHost(async (host) => {
			expect(installPexToolchain("2.97.1", "/tmp/pex")).toBe(
				"/cache/pex-toolchains/2.97.1",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "pex-toolchains" &&
						call[2] === "2.97.1",
				),
			).toBe(true);
		});
	});

	test("resolves the pex zipapp out of the install task's named cache", async () => {
		await withPexHost(async (host) => {
			pexToolchain("2.97.1", { default: true, unverified: true });

			expect(await pexBin()).toBe("/cache/pex-toolchains/2.97.1/pex");
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/pantsbuild/pex/releases/download/v2.97.1/pex",
			);
			// The install run marks the zipapp executable; there is no archive.
			expect(install.argv[2]).toContain("chmod +x");
			expect(install.outputs[0].namedCache.name).toBe("pex-toolchains");
			expect(install.outputs[0].namedCache.key).toBe("2.97.1");
		});
	});

	test("the graph pex tool is a named-cache mount, not a staged tree", async () => {
		await withPexHost(async (host) => {
			pexToolchain("2.97.1", { default: true, unverified: true });

			const binding = await host.resolve(pexGraphTool("2.97.1"));

			expect(binding.type).toBe("tool");
			expect(binding.mountName).toBe("pex");
			expect(binding.cache).toBe("pex-toolchains");
			expect(binding.key).toBe("2.97.1");
			expect(binding.binDirs.join(",")).toBe(".");
		});
	});

	test("describes the named-cache-backed pex tool", async () => {
		await withPexHost(async () => {
			pexToolchain("2.97.1", { default: true, unverified: true });
			const tool = await pexTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("pex");
			expect(tool.cache).toBe("pex-toolchains");
			expect(tool.key).toBe("2.97.1");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withPexHost(async () => {
			pexToolchain("2.97.1", { default: true });
			let message = null;
			try {
				await pexBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("the bundled lockfile is the default", async () => {
		await withPexHost(async (host) => {
			host.addFile(BUNDLED_LOCKFILE, pexLock("2.97.1", "cafe"));
			pexToolchain("2.97.1", { default: true });

			await pexBin();

			expect(readAddresses(host)).toContain(BUNDLED_LOCKFILE);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withPexHost(async (host) => {
			host.addFile("//locks/pex.lock", pexLock("2.98.0", "beef"));
			pexToolchain("2.98.0", {
				default: true,
				lockfile: "//locks/pex.lock",
			});

			await pexBin();

			expect(readAddresses(host)).toContain("//locks/pex.lock");
			expect(readAddresses(host).includes(BUNDLED_LOCKFILE)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withPexHost(async () => {
			pexToolchain("2.98.0", {
				default: true,
				lockfile: "//locks/pex.lock",
			});
			let message = null;
			try {
				await pexBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/pex.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withPexHost(() => {
			expect(() =>
				pexToolchain("2.98.0", { lockfile: "locks/pex.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withPexHost(async (host) => {
			pexToolchain("2.98.0", {
				default: true,
				lockfile: "//locks/pex.lock",
			});

			await host.resolve(pexGenLockfiles()[GEN_LOCKFILES]);

			expect(host.runs.some((r) => r.display === "write locks/pex.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withPexHost(async (host) => {
			pexToolchain("2.98.0", {
				default: true,
				lockfile: "//locks/pex.lock",
			});

			await host.resolve(
				pexGenLockfiles("2.98.0", { lockfile: "//other/pex.lock" })[
					GEN_LOCKFILES
				],
			);

			expect(host.runs.some((r) => r.display === "write other/pex.lock")).toBe(
				true,
			);
		});
	});
});
