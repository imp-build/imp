import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetCmakeToolchainStateForTest,
	cmakeCacheKey,
	cmakeBin,
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
