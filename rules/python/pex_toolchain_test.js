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
	pexTool,
	pexToolchain,
} from "//rules/python/pex_toolchain";

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
});
