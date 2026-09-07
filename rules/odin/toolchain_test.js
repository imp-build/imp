import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetOdinToolchainStateForTest,
	defaultOdinLinkerToolchain,
	odinArtifactName,
	odinBin,
	odinCacheKey,
	odinGenLockfiles,
	odinGraphTool,
	odinLinkerFor,
	odinTool,
	odinToolchain,
} from "//rules/odin/toolchain";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const BUNDLED_LOCKFILE = "//rules/odin/odin.lock";

// A one-version, one-platform lock for the platform withFakeToolchainHost
// reports (linux/x86_64). The sha is what the download argv is checked for,
// so each lock in a test gets its own.
function odinLock(version, sha256) {
	return JSON.stringify({
		tool: "odin",
		versions: {
			[version]: {
				"linux/x86_64": {
					url: "https://locked.example/odin.tar.gz",
					artifact: "odin.tar.gz",
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

function withOdinHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetOdinToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetOdinToolchainStateForTest();
		}
	});
}

describe("Odin graph toolchain", () => {
	test("formats release identity", () => {
		expect(
			odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe("odin-linux-amd64-dev-2026-03.tar.gz");
		expect(odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" })).toBe(
			"dev-2026-03/linux-x86_64",
		);
	});

	test("declares verified graph tools", () => {
		expect(
			odinToolchain("dev-2026-03", { default: true }).__imp_graph_handle,
		).toBe(true);
		expect(odinGraphTool("dev-2026-03").__imp_graph_handle).toBe(true);
	});

	test("odinLinkerFor/defaultOdinLinkerToolchain read back opts.linker declared per version", () => {
		return withOdinHost(() => {
			expect(odinLinkerFor("dev-2026-03")).toBe(null);
			expect(defaultOdinLinkerToolchain()).toBe(null);

			const linker = { __imp_graph_handle: true, tool: {}, version: "2.41.0" };
			odinToolchain("dev-2026-03", { default: true, linker });

			expect(odinLinkerFor("dev-2026-03")).toBe(linker);
			expect(defaultOdinLinkerToolchain()).toBe(linker);
			expect(odinLinkerFor("no-such-version")).toBe(null);
		});
	});

	test("declares the shared named cache the install task publishes into", () => {
		return withOdinHost((host) => {
			odinToolchain("dev-2026-03", { default: true });

			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "odin-toolchains",
				),
			).toBe(true);
		});
	});

	test("resolves the odin binary out of the install task's named cache", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true, unverified: true });
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });

			expect(await odinBin()).toBe(`/cache/odin-toolchains/${key}/odin`);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/odin-lang/Odin/releases/download/dev-2026-03/odin-linux-amd64-dev-2026-03.tar.gz",
			);
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("odin-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("describes the named-cache-backed odin tool", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-03", { default: true, unverified: true });
			const tool = await odinTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("odin");
			expect(tool.cache).toBe("odin-toolchains");
			expect(tool.key).toBe("dev-2026-03/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});

	test("the graph odin tool is a named-cache mount, not a staged tree", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true, unverified: true });
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });

			const binding = await host.resolve(odinGraphTool("dev-2026-03"));

			expect(binding.type).toBe("tool");
			expect(binding.mountName).toBe("odin");
			expect(binding.cache).toBe("odin-toolchains");
			expect(binding.key).toBe(key);
			expect(binding.binDirs.join(",")).toBe(".");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-03", { default: true });
			let message = null;
			try {
				await odinBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("the bundled lockfile is the default", async () => {
		await withOdinHost(async (host) => {
			host.addFile(BUNDLED_LOCKFILE, odinLock("dev-2026-03", "cafe"));
			odinToolchain("dev-2026-03", { default: true });

			await odinBin();

			expect(readAddresses(host)).toContain(BUNDLED_LOCKFILE);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withOdinHost(async (host) => {
			host.addFile("//locks/odin.lock", odinLock("dev-2026-05", "beef"));
			odinToolchain("dev-2026-05", {
				default: true,
				lockfile: "//locks/odin.lock",
			});

			await odinBin();

			expect(readAddresses(host)).toContain("//locks/odin.lock");
			expect(readAddresses(host).includes(BUNDLED_LOCKFILE)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-05", {
				default: true,
				lockfile: "//locks/odin.lock",
			});
			let message = null;
			try {
				await odinBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/odin.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withOdinHost(() => {
			expect(() =>
				odinToolchain("dev-2026-05", { lockfile: "locks/odin.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-05", {
				default: true,
				lockfile: "//locks/odin.lock",
			});

			await host.resolve(odinGenLockfiles()[GEN_LOCKFILES]);

			expect(host.runs.some((r) => r.display === "write locks/odin.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-05", {
				default: true,
				lockfile: "//locks/odin.lock",
			});

			await host.resolve(
				odinGenLockfiles("dev-2026-05", { lockfile: "//other/odin.lock" })[
					GEN_LOCKFILES
				],
			);

			expect(host.runs.some((r) => r.display === "write other/odin.lock")).toBe(
				true,
			);
		});
	});
});
