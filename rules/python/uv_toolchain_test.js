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
	uvGenLockfiles,
	uvTool,
	uvToolchain,
} from "//rules/python/uv_toolchain";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const BUNDLED_LOCKFILE = "//rules/python/uv-toolchain.lock";

// A one-version, one-platform lock for the platform withFakeToolchainHost
// reports (linux/x86_64). The sha is what the download argv is checked for,
// so each lock in a test gets its own.
function uvLock(version, sha256) {
	return JSON.stringify({
		tool: "uv-toolchain",
		versions: {
			[version]: {
				"linux/x86_64": {
					url: "https://locked.example/uv.tar.gz",
					artifact: "uv.tar.gz",
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

	test("the bundled lockfile is the default", async () => {
		await withUvHost(async (host) => {
			host.addFile(BUNDLED_LOCKFILE, uvLock("0.11.16", "cafe"));
			uvToolchain("0.11.16", { default: true });

			await uvBin();

			expect(readAddresses(host)).toContain(BUNDLED_LOCKFILE);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withUvHost(async (host) => {
			host.addFile("//locks/uv.lock", uvLock("0.11.17", "beef"));
			uvToolchain("0.11.17", {
				default: true,
				lockfile: "//locks/uv.lock",
			});

			await uvBin();

			expect(readAddresses(host)).toContain("//locks/uv.lock");
			expect(readAddresses(host).includes(BUNDLED_LOCKFILE)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withUvHost(async () => {
			uvToolchain("0.11.17", {
				default: true,
				lockfile: "//locks/uv.lock",
			});
			let message = null;
			try {
				await uvBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/uv.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withUvHost(() => {
			expect(() =>
				uvToolchain("0.11.17", { lockfile: "locks/uv.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.17", {
				default: true,
				lockfile: "//locks/uv.lock",
			});

			await host.resolve(uvGenLockfiles()[GEN_LOCKFILES]);

			expect(host.runs.some((r) => r.display === "write locks/uv.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withUvHost(async (host) => {
			uvToolchain("0.11.17", {
				default: true,
				lockfile: "//locks/uv.lock",
			});

			await host.resolve(
				uvGenLockfiles("0.11.17", { lockfile: "//other/uv.lock" })[
					GEN_LOCKFILES
				],
			);

			expect(host.runs.some((r) => r.display === "write other/uv.lock")).toBe(
				true,
			);
		});
	});
});
