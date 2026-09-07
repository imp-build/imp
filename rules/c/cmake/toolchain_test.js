import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetCmakeToolchainStateForTest,
	cmakeCacheKey,
	cmakeBin,
	cmakeGraphTool,
	cmakeGraphToolSpec,
	cmakeToolchain,
	defaultCmakeToolchainVersion,
	installCmakeToolchain,
} from "//rules/c/cmake";

function withCmakeHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetCmakeToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetCmakeToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("CMake toolchain", () => {
	test("declares a default CMake toolchain", () => {
		return withCmakeHost((host) => {
			const toolchain = cmakeToolchain("3.30.5", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("3.30.5");
			expect(
				cmakeCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("3.30.5/linux-x86_64");
			expect(defaultCmakeToolchainVersion()).toBe("3.30.5");
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "cmake-toolchains",
				),
			).toBe(true);
		});
	});

	test("uses system cmake without a declared toolchain", async () => {
		await withCmakeHost(async () => {
			expect(await cmakeBin()).toBe("cmake");
		});
	});

	test("installCmakeToolchain publishes a local toolchain into the named cache", async () => {
		await withCmakeHost(async (host) => {
			const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

			expect(installCmakeToolchain("3.30.5", "/tmp/cmake-3.30.5")).toBe(
				"/cache/cmake-toolchains/3.30.5/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "cmake-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/cmake-3.30.5",
				),
			).toBe(true);
		});
	});

	test("cmakeGraphToolSpec describes the named-cache-backed cmake tool, freshly constructible", () => {
		return withCmakeHost(() => {
			cmakeToolchain("3.30.5", { default: true });
			const tool = cmakeGraphToolSpec("3.30.5");

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("cmake");
			expect(tool.cache).toBe("cmake-toolchains");
			expect(tool.key).toBe("3.30.5/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe("bin");
		});
	});

	test("the graph cmake tool is a named-cache mount, not a staged tree", async () => {
		await withCmakeHost(async (host) => {
			cmakeToolchain("3.30.5", { default: true, unverified: true });
			const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

			const binding = await host.resolve(cmakeGraphTool("3.30.5"));

			expect(binding.type).toBe("tool");
			expect(binding.mountName).toBe("cmake");
			expect(binding.cache).toBe("cmake-toolchains");
			expect(binding.key).toBe(key);
			expect(binding.binDirs.join(",")).toBe("bin");
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withCmakeHost(async (host) => {
			const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/c/cmake/cmake.lock",
				JSON.stringify({
					tool: "cmake",
					versions: {
						"3.30.5": {
							"linux/x86_64": {
								url: "https://locked.example/cmake-3.30.5-linux-x86_64.tar.gz",
								artifact: "cmake-3.30.5-linux-x86_64.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			cmakeToolchain("3.30.5", { default: true });

			expect(await cmakeBin("3.30.5")).toBe(
				"/cache/cmake-toolchains/3.30.5/linux-x86_64/bin/cmake",
			);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/cmake-3.30.5-linux-x86_64.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("cmake-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});
});

describe("CMake workspace lockfile selection", () => {
	const BUNDLED = "//rules/c/cmake/cmake.lock";

	function cmakeLock(version, sha256) {
		return JSON.stringify({
			tool: "cmake",
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
		await withCmakeHost(async (host) => {
			host.addFile(BUNDLED, cmakeLock("3.31.0", "cafe"));
			cmakeToolchain("3.31.0", { default: true });

			await cmakeBin("3.31.0");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withCmakeHost(async (host) => {
			host.addFile("//locks/cmake.lock", cmakeLock("3.30.5", "beef"));
			cmakeToolchain("3.30.5", {
				default: true,
				lockfile: "//locks/cmake.lock",
			});

			await cmakeBin("3.30.5");

			expect(readAddresses(host)).toContain("//locks/cmake.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withCmakeHost(async () => {
			cmakeToolchain("3.30.5", {
				default: true,
				lockfile: "//locks/cmake.lock",
			});
			let message = null;
			try {
				await cmakeBin("3.30.5");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/cmake.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withCmakeHost(() => {
			expect(() =>
				cmakeToolchain("3.30.5", { lockfile: "locks/cmake.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withCmakeHost(async (host) => {
			const toolchain = cmakeToolchain("3.30.5", {
				default: true,
				lockfile: "//locks/cmake.lock",
			});
			await host.resolve(toolchain[GEN_LOCKFILES]);
			expect(
				host.runs.some((r) => r.display === "write locks/cmake.lock"),
			).toBe(true);
		});
	});
});
