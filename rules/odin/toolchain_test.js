import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetOdinToolchainStateForTest,
	acquireOdinToolchain,
	defaultOdinToolchain,
	defaultOdinToolchainVersion,
	odinArtifactName,
	odinBin,
	odinCacheKey,
	odinDownloadUrl,
	odinTool,
	odinToolchain,
} from "//rules/odin/toolchain";

function withOdinHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetOdinToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetOdinToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("Odin toolchain", () => {
	test("formats release artifact names", () => {
		expect(
			odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe("odin-linux-amd64-dev-2026-03.tar.gz");
		expect(
			odinArtifactName("dev-2026-03", { os: "macos", arch: "aarch64" }),
		).toBe("odin-macos-arm64-dev-2026-03.tar.gz");
		expect(
			odinArtifactName("dev-2026-03", { os: "windows", arch: "x86_64" }),
		).toBe("odin-windows-amd64-dev-2026-03.zip");
	});

	test("declares a default toolchain target", () => {
		return withOdinHost((host) => {
			const toolchain = odinToolchain("dev-2026-03", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("dev-2026-03");
			expect(
				odinCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("dev-2026-03/linux-x86_64");
			expect(defaultOdinToolchainVersion()).toBe("dev-2026-03");
			expect(defaultOdinToolchain()).toBe(toolchain);
			expect(host.calls[0][0]).toBe("namedCache");
		});
	});

	test("throws when no lockfile entry pins the requested version", async () => {
		await withOdinHost(async () => {
			let message = null;

			try {
				await acquireOdinToolchain("dev-2026-03");
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no lockfile found");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-03");
			let message = null;

			try {
				await odinBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no Odin toolchain version specified");
		});
	});

	test("uses an existing toolchain cache entry", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });
			host.install("odin-toolchains", key, "/tmp/imp-odin-dev-2026-03");

			const dir = await acquireOdinToolchain("dev-2026-03");

			expect(dir).toBe("/tmp/imp-odin-dev-2026-03");
			expect(host.runs.length).toBe(0);
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withOdinHost(async (host) => {
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/odin/odin.lock",
				JSON.stringify({
					tool: "odin",
					versions: {
						"dev-2026-03": {
							"linux/x86_64": {
								url: "https://locked.example/odin-linux-amd64-dev-2026-03.tar.gz",
								artifact: "odin-linux-amd64-dev-2026-03.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			odinToolchain("dev-2026-03", { default: true });
			const path = await acquireOdinToolchain("dev-2026-03");

			expect(path).toBe("/cache/odin-toolchains/dev-2026-03/linux-x86_64");
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/odin-linux-amd64-dev-2026-03.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("odin-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);

			expect(
				host.calls.some(
					(call) => call[0] === "nativeTool" && call[1] === "curl",
				),
			).toBe(true);
		});
	});

	test("uses the default version for odin binary lookup", () => {
		return withOdinHost({ os: "windows", arch: "x86_64" }, async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			const key = odinCacheKey("dev-2026-03", {
				os: "windows",
				arch: "x86_64",
			});
			host.install(
				"odin-toolchains",
				key,
				"/cache/odin-toolchains/dev-2026-03/windows-x86_64",
			);

			expect(await odinBin()).toBe(
				"/cache/odin-toolchains/dev-2026-03/windows-x86_64/odin.exe",
			);
		});
	});

	test("describes the named-cache-backed odin tool", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });
			host.install("odin-toolchains", key, "/cache/odin-toolchains/" + key);

			const tool = await odinTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("odin");
			expect(tool.cache).toBe("odin-toolchains");
			expect(tool.key).toBe("dev-2026-03/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});
});
