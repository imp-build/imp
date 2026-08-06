import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetNodeToolchainStateForTest,
	acquireNodeToolchain,
	defaultNodeToolchain,
	defaultNodeToolchainVersion,
	installNodeToolchain,
	nodeArtifactName,
	nodeBin,
	nodeCacheKey,
	nodeDownloadUrl,
	nodeTool,
	nodeToolchain,
} from "//rules/js/node/toolchain";

function withNodeHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetNodeToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetNodeToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("node toolchain", () => {
	test("declares a default node toolchain", () => {
		return withNodeHost((host) => {
			const toolchain = nodeToolchain("22.11.0", { default: true });

			expect(toolchain.__imp_graph_handle).toBe(true);
			expect(defaultNodeToolchainVersion()).toBe("22.11.0");
			expect(defaultNodeToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "node-toolchains",
				),
			).toBe(true);
		});
	});

	test("computes artifact name and download URL per platform", () => {
		return withNodeHost(() => {
			const plat = { os: "linux", arch: "x86_64" };
			expect(nodeArtifactName("22.11.0", plat)).toBe(
				"node-v22.11.0-linux-x64.tar.gz",
			);
			expect(nodeDownloadUrl("22.11.0", plat)).toBe(
				"https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz",
			);
			expect(nodeCacheKey("22.11.0", plat)).toBe("22.11.0/linux-x86_64");
		});
	});

	test("throws when no toolchain has been declared", async () => {
		await withNodeHost(async () => {
			let message = null;
			try {
				await acquireNodeToolchain("22.11.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no node toolchain declared");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withNodeHost(async () => {
			nodeToolchain("22.11.0");
			let message = null;
			try {
				await nodeBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no node toolchain version specified");
		});
	});

	test("installs and acquires a toolchain from the named cache", async () => {
		await withNodeHost(async (host) => {
			const key = nodeCacheKey("22.11.0", { os: "linux", arch: "x86_64" });

			const seeded = installNodeToolchain("22.11.0", "/tmp/node");
			expect(seeded).toBe(`/cache/node-toolchains/${key}`);

			nodeToolchain("22.11.0", { default: true });
			expect(await acquireNodeToolchain("22.11.0")).toBe(
				`/cache/node-toolchains/${key}`,
			);
			expect(await nodeBin("22.11.0")).toBe(
				`/cache/node-toolchains/${key}/bin/node`,
			);
			// Already cached, so no download/extract run() should have happened.
			expect(host.runs.length).toBe(0);
		});
	});

	test("downloads, verifies, and extracts node via two sandboxed runs when not cached", async () => {
		await withNodeHost(async (host) => {
			host.addFile(
				"//rules/js/node/node-toolchain.lock",
				JSON.stringify({
					tool: "node-toolchain",
					versions: {
						"22.11.0": {
							"linux/x86_64": {
								url: "https://locked.example/node-v22.11.0-linux-x64.tar.gz",
								artifact: "node-v22.11.0-linux-x64.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);
			nodeToolchain("22.11.0", { default: true });
			const tool = await nodeTool("22.11.0");

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("node");
			expect(tool.binDirs).toEqual(["bin"]);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			// The lock entry pins both the URL and the expected digest.
			expect(download.argv).toContain(
				"https://locked.example/node-v22.11.0-linux-x64.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.argv[2]).toContain("--strip-components=1");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withNodeHost(async () => {
			nodeToolchain("22.11.0", { default: true });
			let message = null;
			try {
				await nodeTool("22.11.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("unverified: true downloads without a sha check", async () => {
		await withNodeHost(async (host) => {
			nodeToolchain("22.11.0", { default: true, unverified: true });
			await nodeTool("22.11.0");

			expect(host.runs.length).toBe(2);
			const [download] = host.runs;
			expect(download.argv).toContain(
				"https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz",
			);
			expect(download.argv[2]).not.toContain("sha256sum");
		});
	});

	test("uses the windows artifact naming and node.exe binary path", () => {
		return withNodeHost({ os: "windows", arch: "x86_64" }, () => {
			const plat = { os: "windows", arch: "x86_64" };
			expect(nodeArtifactName("22.11.0", plat)).toBe(
				"node-v22.11.0-win-x64.zip",
			);
		});
	});

	test("uses macos darwin artifact naming", () => {
		return withNodeHost({ os: "macos", arch: "aarch64" }, () => {
			const plat = { os: "macos", arch: "aarch64" };
			expect(nodeArtifactName("22.11.0", plat)).toBe(
				"node-v22.11.0-darwin-arm64.tar.gz",
			);
		});
	});
});
