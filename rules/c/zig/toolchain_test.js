import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetZigToolchainStateForTest,
	defaultZigGraphToolchain,
	defaultZigToolchainVersion,
	installZigToolchain,
	zigArtifactName,
	zigCacheKey,
	zigBin,
	zigGraphCacheEnv,
	zigGraphToolchain,
	zigToolchain,
} from "//rules/c/zig";

function withZigHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetZigToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetZigToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("Zig toolchain", () => {
	test("declares a default Zig toolchain", () => {
		return withZigHost((host) => {
			const toolchain = zigToolchain("0.13.0", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("0.13.0");
			expect(
				zigCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("0.13.0/linux-x86_64");
			expect(defaultZigToolchainVersion()).toBe("0.13.0");
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "zig-toolchains",
				),
			).toBe(true);
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withZigHost(async () => {
			zigToolchain("0.13.0");
			let message = null;

			try {
				await zigBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no Zig toolchain version specified");
		});
	});

	test("installZigToolchain publishes a local toolchain into the named cache", async () => {
		await withZigHost(async (host) => {
			const key = zigCacheKey("0.13.0", { os: "linux", arch: "x86_64" });

			expect(installZigToolchain("0.13.0", "/tmp/zig-0.13.0")).toBe(
				"/cache/zig-toolchains/0.13.0/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "zig-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/zig-0.13.0",
				),
			).toBe(true);
		});
	});

	test("downloads, verifies, and installs a toolchain via sandboxed runs (linux)", async () => {
		await withZigHost(async (host) => {
			const key = zigCacheKey("0.13.0", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/c/zig/zig.lock",
				JSON.stringify({
					tool: "zig",
					versions: {
						"0.13.0": {
							"linux/x86_64": {
								url: "https://locked.example/zig-linux-x86_64-0.13.0.tar.xz",
								artifact: "zig-linux-x86_64-0.13.0.tar.xz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			zigToolchain("0.13.0", { default: true });

			expect(await zigBin("0.13.0")).toBe(
				"/cache/zig-toolchains/0.13.0/linux-x86_64/zig",
			);
			// Verified download plus install. The zig-build-cache prewarm is its
			// own graph tool (zigGraphToolchain), not part of getting the binary.
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/zig-linux-x86_64-0.13.0.tar.xz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");

			expect(install.argv[0]).toBe("sh");
			// 0.13.0 predates the 0.14.1 filename-order switch, so it's
			// zig-<os>-<arch>-..., not zig-<arch>-<os>-....
			expect(
				install.argv.some((arg) =>
					arg.includes("zig-linux-x86_64-0.13.0.tar.xz"),
				),
			).toBe(true);
			// Linux tar.xz decompression needs a separate xz process; Windows sh
			// isn't needed on this platform.
			expect(install.tools.some((t) => t.name === "xz")).toBe(true);
			expect(install.tools.some((t) => t.name === "sh")).toBe(false);

			expect(install.argv).toContain("zigar");
			expect(install.argv).toContain("zigranlib");
			expect(
				install.argv.some(
					(arg) => typeof arg === "string" && arg.includes("#!/bin/sh"),
				),
			).toBe(true);
			expect(install.outputs[0].namedCache.name).toBe("zig-toolchains");
			expect(install.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("installs a toolchain on windows with .bat wrappers and a declared sh tool", async () => {
		await withZigHost({ os: "windows", arch: "x86_64" }, async (host) => {
			// unverified: exercises the lockfile-less opt-out path.
			zigToolchain("0.13.0", { default: true, unverified: true });
			await zigBin("0.13.0");

			const [, install] = host.runs;
			expect(
				install.argv.some((arg) =>
					arg.includes("zig-windows-x86_64-0.13.0.zip"),
				),
			).toBe(true);
			expect(install.tools.some((t) => t.name === "sh")).toBe(true);
			expect(install.tools.some((t) => t.name === "xz")).toBe(false);
			// Extracted with unzip, not tar — see coreToolNames()'s own comment
			// on why a bare "tar" on Windows can't be trusted to resolve to a
			// zip-capable implementation.
			expect(install.tools.some((t) => t.name === "unzip")).toBe(true);
			expect(install.tools.some((t) => t.name === "mv")).toBe(true);
			expect(install.tools.some((t) => t.name === "tar")).toBe(false);
			expect(install.argv[2]).toContain("unzip -q");
			expect(install.argv[2]).not.toContain(" tar ");

			expect(install.argv).toContain("zigar.bat");
			expect(install.argv).toContain("zigranlib.bat");
			expect(
				install.argv.some(
					(arg) =>
						typeof arg === "string" && arg.includes('@"%~dp0zig.exe" ar %*'),
				),
			).toBe(true);
		});
	});

	test("uses legacy os-then-arch artifact naming through 0.14.0", () => {
		expect(zigArtifactName("0.13.0", { os: "linux", arch: "x86_64" })).toBe(
			"zig-linux-x86_64-0.13.0.tar.xz",
		);
		expect(zigArtifactName("0.14.0", { os: "windows", arch: "x86_64" })).toBe(
			"zig-windows-x86_64-0.14.0.zip",
		);
	});

	test("uses current arch-then-os artifact naming from 0.14.1 onward", () => {
		expect(zigArtifactName("0.14.1", { os: "linux", arch: "x86_64" })).toBe(
			"zig-x86_64-linux-0.14.1.tar.xz",
		);
		expect(zigArtifactName("0.16.0", { os: "windows", arch: "aarch64" })).toBe(
			"zig-aarch64-windows-0.16.0.zip",
		);
	});

	test("treats non-numeric versions (dev builds) as current naming", () => {
		expect(
			zigArtifactName("0.17.0-dev.1267+300116b02", {
				os: "linux",
				arch: "x86_64",
			}),
		).toBe("zig-x86_64-linux-0.17.0-dev.1267+300116b02.tar.xz");
	});

	test("declares a graph-native zig toolchain with both the toolchain and build-cache tools", () => {
		return withZigHost((host) => {
			zigToolchain("0.16.0", { default: true });
			const graph = zigGraphToolchain("0.16.0");

			expect(graph.tool.__imp_graph_handle).toBe(true);
			expect(graph.buildCacheTool.__imp_graph_handle).toBe(true);
			expect(graph.version).toBe("0.16.0");
			expect(Object.isFrozen(graph)).toBe(true);
		});
	});

	test("graph toolchain construction does not touch the host run()", () => {
		return withZigHost((host) => {
			zigToolchain("0.16.0", { default: true });
			zigGraphToolchain("0.16.0");

			// Building the graph is pure node construction — nothing executes
			// until a workflow resolves the task, matching Odin/Rust/gcc/mold's
			// precedent.
			expect(host.runs.length).toBe(0);
		});
	});

	test("defaultZigGraphToolchain resolves the declared default, or null", () => {
		return withZigHost((host) => {
			expect(defaultZigGraphToolchain()).toBe(null);

			zigToolchain("0.16.0", { default: true });
			const graph = defaultZigGraphToolchain();

			expect(graph.version).toBe("0.16.0");
		});
	});

	test("zigGraphCacheEnv resolves ZIG_GLOBAL_CACHE_DIR via exec.path()", () => {
		return withZigHost(() => {
			const exec = { path: (binding) => binding.__fakePath };
			const buildCacheTool = { __fakePath: "/sandbox/zig-build-cache" };

			expect(zigGraphCacheEnv(exec, buildCacheTool)).toEqual([
				"ZIG_GLOBAL_CACHE_DIR=/sandbox/zig-build-cache",
			]);
		});
	});
});
