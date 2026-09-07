import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetNodeToolchainStateForTest,
	defaultNodeToolchain,
	defaultNodeToolchainVersion,
	installNodeToolchain,
	nodeArtifactName,
	nodeBin,
	nodeCacheKey,
	nodeDownloadUrl,
	nodeGenLockfiles,
	nodeGraphTool,
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

	test("installNodeToolchain publishes a local toolchain into the named cache", async () => {
		await withNodeHost(async () => {
			const key = nodeCacheKey("22.11.0", { os: "linux", arch: "x86_64" });

			expect(installNodeToolchain("22.11.0", "/tmp/node")).toBe(
				`/cache/node-toolchains/${key}`,
			);
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
			const key = nodeCacheKey("22.11.0", { os: "linux", arch: "x86_64" });

			expect(await nodeBin("22.11.0")).toBe(
				`/cache/node-toolchains/${key}/bin/node`,
			);
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

	test("the graph node tool is a named-cache mount, not a staged tree", async () => {
		await withNodeHost(async (host) => {
			nodeToolchain("22.11.0", { default: true, unverified: true });
			const key = nodeCacheKey("22.11.0", { os: "linux", arch: "x86_64" });

			const binding = await host.resolve(nodeGraphTool("22.11.0"));

			expect(binding.type).toBe("tool");
			expect(binding.mountName).toBe("node");
			expect(binding.cache).toBe("node-toolchains");
			expect(binding.key).toBe(key);
			expect(binding.binDirs.join(",")).toBe("bin");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withNodeHost(async () => {
			nodeToolchain("22.11.0", { default: true });
			let message = null;
			try {
				await nodeBin("22.11.0");
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
			await nodeBin("22.11.0");

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

describe("node workspace lockfile selection", () => {
	const BUNDLED = "//rules/js/node/node-toolchain.lock";

	function nodeLock(version, sha256) {
		return JSON.stringify({
			tool: "node-toolchain",
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
		await withNodeHost(async (host) => {
			host.addFile(BUNDLED, nodeLock("22.11.0", "cafe"));
			nodeToolchain("22.11.0", { default: true });

			await nodeBin("22.11.0");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withNodeHost(async (host) => {
			host.addFile("//locks/node.lock", nodeLock("20.10.0", "beef"));
			nodeToolchain("20.10.0", {
				default: true,
				lockfile: "//locks/node.lock",
			});

			await nodeBin("20.10.0");

			expect(readAddresses(host)).toContain("//locks/node.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withNodeHost(async () => {
			nodeToolchain("20.10.0", {
				default: true,
				lockfile: "//locks/node.lock",
			});
			let message = null;
			try {
				await nodeBin("20.10.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/node.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withNodeHost(() => {
			expect(() =>
				nodeToolchain("20.10.0", { lockfile: "locks/node.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withNodeHost(async (host) => {
			nodeToolchain("20.10.0", {
				default: true,
				lockfile: "//locks/node.lock",
			});
			await host.resolve(nodeGenLockfiles("20.10.0")[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/node.lock")).toBe(
				true,
			);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withNodeHost(async (host) => {
			nodeToolchain("20.10.0", {
				default: true,
				lockfile: "//locks/node.lock",
			});
			await host.resolve(
				nodeGenLockfiles("20.10.0", { lockfile: "//other/node.lock" })[
					GEN_LOCKFILES
				],
			);
			expect(host.runs.some((r) => r.display === "write other/node.lock")).toBe(
				true,
			);
		});
	});
});
