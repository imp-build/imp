import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetUvToolchainStateForTest,
	defaultUvToolchain,
	defaultUvToolchainVersion,
	installUvToolchain,
	uvArtifactName,
	uvBin,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvCacheKey,
	uvDownloadUrl,
	uvTool,
	uvToolchain,
} from "//rules/python/uv_toolchain";

function withUvHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetUvToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetUvToolchainStateForTest();
		}
	});
}

describe("uv toolchain", () => {
	test("computes artifact name, download URL and cache key per platform", () => {
		const plat = { os: "linux", arch: "x86_64" };
		expect(uvArtifactName("0.11.16", plat)).toBe(
			"uv-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(uvDownloadUrl("0.11.16", plat)).toBe(
			"https://github.com/astral-sh/uv/releases/download/0.11.16/uv-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(uvCacheKey("0.11.16", plat)).toBe("0.11.16/linux-x86_64");
	});

	test("declares a default uv toolchain", () => {
		return withUvHost((host) => {
			const tool = uvToolchain("0.11.16", { default: true });

			expect(tool.__imp_graph_handle).toBe(true);
			expect(defaultUvToolchainVersion()).toBe("0.11.16");
			expect(defaultUvToolchain()).toBe(tool);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "uv-toolchains",
				),
			).toBe(true);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "uv-cache-dir",
				),
			).toBe(true);
		});
	});

	test("installUvToolchain publishes a local toolchain into the named cache", async () => {
		await withUvHost(async () => {
			expect(installUvToolchain("0.11.16", "/tmp/uv")).toBe(
				"/cache/uv-toolchains/0.11.16/linux-x86_64",
			);
		});
	});

	test("resolves the uv binary out of the install task's named cache", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const key = uvCacheKey("0.11.16", { os: "linux", arch: "x86_64" });

			expect(await uvBin()).toBe(`/cache/uv-toolchains/${key}/uv`);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/astral-sh/uv/releases/download/0.11.16/uv-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("uv-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("uvTool seeds the shared uv cache dir it is paired with", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.16", { default: true, unverified: true });
			const tool = await uvTool();

			expect(tool.kind).toBe("tool");
			expect(tool.cache).toBe("uv-toolchains");

			// uvCacheDirTool() mounts uv-cache-dir, and a tool mount needs its
			// cache path to exist on disk — so uvTool() must run the seed.
			const seed = host.runs.find((entry) =>
				entry.outputs.some(
					(out) => out.namedCache && out.namedCache.name === "uv-cache-dir",
				),
			);
			expect(seed !== undefined).toBe(true);
			expect(seed.outputs[0].namedCache.key).toBe("shared");
			expect(uvCacheDirTool().cache).toBe("uv-cache-dir");
			expect(uvCacheDirEnv()[0]).toBe("UV_CACHE_DIR=.imp/tools/uv-cache-dir");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withUvHost(async () => {
			uvToolchain("0.11.16", { default: true });
			let message = null;
			try {
				await uvBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});
});
