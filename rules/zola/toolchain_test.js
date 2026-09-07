import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetZolaToolchainStateForTest,
	defaultZolaToolchain,
	defaultZolaToolchainVersion,
	installZolaToolchain,
	zolaBin,
	zolaArtifactName,
	zolaCacheKey,
	zolaDownloadUrl,
	zolaGraphTool,
	zolaTool,
	zolaToolchain,
} from "//rules/zola";

function withZolaHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetZolaToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetZolaToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("zola toolchain", () => {
	test("builds artifact name / download URL per platform", () => {
		expect(zolaArtifactName("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(zolaArtifactName("0.22.1", { os: "macos", arch: "aarch64" })).toBe(
			"zola-v0.22.1-aarch64-apple-darwin.tar.gz",
		);
		expect(zolaArtifactName("0.22.1", { os: "windows", arch: "x86_64" })).toBe(
			"zola-v0.22.1-x86_64-pc-windows-msvc.zip",
		);
		expect(zolaDownloadUrl("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"https://github.com/getzola/zola/releases/download/v0.22.1/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"0.22.1/linux-x86_64",
		);
	});

	test("declares a graph-native zola tool", () => {
		expect(zolaGraphTool("0.22.1").__imp_graph_handle).toBe(true);
	});

	test("declares a default zola toolchain", () => {
		return withZolaHost((host) => {
			const toolchain = zolaToolchain("0.22.1", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("0.22.1");
			expect(defaultZolaToolchainVersion()).toBe("0.22.1");
			expect(defaultZolaToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "zola-toolchains",
				),
			).toBe(true);
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withZolaHost(async () => {
			zolaToolchain("0.22.1");
			let message = null;

			try {
				await zolaBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no zola toolchain version specified");
		});
	});

	test("installZolaToolchain publishes a local toolchain into the named cache", async () => {
		await withZolaHost(async (host) => {
			const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });

			expect(installZolaToolchain("0.22.1", "/tmp/zola-0.22.1")).toBe(
				"/cache/zola-toolchains/0.22.1/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "zola-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/zola-0.22.1",
				),
			).toBe(true);
		});
	});

	test("describes the named-cache-backed zola tool", async () => {
		await withZolaHost(async () => {
			zolaToolchain("0.22.1", { default: true, unverified: true });
			const tool = await zolaTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("zola");
			expect(tool.cache).toBe("zola-toolchains");
			expect(tool.key).toBe("0.22.1/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withZolaHost(async (host) => {
			const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/zola/zola.lock",
				JSON.stringify({
					tool: "zola",
					versions: {
						"0.22.1": {
							"linux/x86_64": {
								url: "https://locked.example/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
								artifact: "zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			zolaToolchain("0.22.1", { default: true });

			expect(await zolaBin("0.22.1")).toBe(
				"/cache/zola-toolchains/0.22.1/linux-x86_64/zola",
			);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.outputs[0].namedCache.name).toBe("zola-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("throws for an unsupported platform", () => {
		let message = null;
		try {
			zolaArtifactName("0.22.1", { os: "freebsd", arch: "x86_64" });
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("unsupported zola toolchain platform");
	});
});

describe("zola workspace lockfile selection", () => {
	const BUNDLED = "//rules/zola/zola.lock";

	function zolaLock(version, sha256) {
		return JSON.stringify({
			tool: "zola",
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
		await withZolaHost(async (host) => {
			host.addFile(BUNDLED, zolaLock("0.22.1", "cafe"));
			zolaToolchain("0.22.1", { default: true });

			await zolaBin("0.22.1");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withZolaHost(async (host) => {
			host.addFile("//locks/zola.lock", zolaLock("0.21.0", "beef"));
			zolaToolchain("0.21.0", { default: true, lockfile: "//locks/zola.lock" });

			await zolaBin("0.21.0");

			expect(readAddresses(host)).toContain("//locks/zola.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withZolaHost(async () => {
			zolaToolchain("0.21.0", { default: true, lockfile: "//locks/zola.lock" });
			let message = null;
			try {
				await zolaBin("0.21.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/zola.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withZolaHost(() => {
			expect(() =>
				zolaToolchain("0.21.0", { lockfile: "locks/zola.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withZolaHost(async (host) => {
			const toolchain = zolaToolchain("0.21.0", {
				default: true,
				lockfile: "//locks/zola.lock",
			});
			await host.resolve(toolchain[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/zola.lock")).toBe(
				true,
			);
		});
	});
});
