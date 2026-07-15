import { productFor } from "imp:core";
import { ODIN_LINKER } from "//rules/odin/products";
import { RUST_LINKER } from "//rules/rust/products";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetMoldToolchainStateForTest,
	acquireMoldToolchain,
	defaultMoldToolchain,
	defaultMoldToolchainVersion,
	installMoldToolchain,
	moldBin,
	moldCacheKey,
	moldTool,
	moldToolchain,
} from "//rules/c/mold/toolchain";

function withMoldHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetMoldToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetMoldToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("mold toolchain", () => {
	test("declares a default mold toolchain", () => {
		return withMoldHost((host) => {
			const toolchain = moldToolchain("2.41.0", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("2.41.0");
			expect(
				moldCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("2.41.0/linux-x86_64");
			expect(defaultMoldToolchainVersion()).toBe("2.41.0");
			expect(defaultMoldToolchain()).toBe(toolchain);
			expect(host.calls[0][0]).toBe("namedCache");
		});
	});

	test("throws when no toolchain has been declared", async () => {
		await withMoldHost(async () => {
			let message = null;

			try {
				await acquireMoldToolchain("2.41.0");
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no mold toolchain declared");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withMoldHost(async () => {
			moldToolchain("2.41.0");
			let message = null;

			try {
				await moldBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no mold toolchain version specified");
		});
	});

	test("installs and acquires a toolchain from the named cache", async () => {
		await withMoldHost(async (host) => {
			const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });

			expect(installMoldToolchain("2.41.0", "/tmp/mold-2.41.0")).toBe(
				"/cache/mold-toolchains/2.41.0/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "mold-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/mold-2.41.0",
				),
			).toBe(true);

			expect(await acquireMoldToolchain("2.41.0")).toBe(
				"/cache/mold-toolchains/2.41.0/linux-x86_64",
			);
			expect(await moldBin("2.41.0")).toBe(
				"/cache/mold-toolchains/2.41.0/linux-x86_64/bin/mold",
			);
			// Already cached, so no download/extract run() should have happened.
			expect(host.runs.length).toBe(0);
		});
	});

	test("describes the named-cache-backed mold tool", async () => {
		await withMoldHost(async () => {
			installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
			moldToolchain("2.41.0", { default: true });
			const tool = await moldTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("mold");
			expect(tool.cache).toBe("mold-toolchains");
			expect(tool.key).toBe("2.41.0/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe("bin");
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withMoldHost(async (host) => {
			const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/c/mold/mold.lock",
				JSON.stringify({
					tool: "mold",
					versions: {
						"2.41.0": {
							"linux/x86_64": {
								url: "https://locked.example/mold-2.41.0-x86_64-linux.tar.gz",
								artifact: "mold-2.41.0-x86_64-linux.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			moldToolchain("2.41.0", { default: true });
			const path = await acquireMoldToolchain("2.41.0");

			expect(path).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			// The lock entry pins both the URL and the expected digest.
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/mold-2.41.0-x86_64-linux.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("mold-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);

			expect(
				host.calls.some(
					(call) => call[0] === "nativeTool" && call[1] === "curl",
				),
			).toBe(true);
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withMoldHost(async () => {
			moldToolchain("2.41.0", { default: true });
			let message = null;
			try {
				await acquireMoldToolchain("2.41.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("unverified: true downloads without a sha check", async () => {
		await withMoldHost(async (host) => {
			moldToolchain("2.41.0", { default: true, unverified: true });
			await acquireMoldToolchain("2.41.0");

			expect(host.runs.length).toBe(2);
			const [download] = host.runs;
			expect(download.argv[2]).not.toContain("sha256sum");
			expect(
				download.argv.some((arg) =>
					arg.includes("mold-2.41.0-x86_64-linux.tar.gz"),
				),
			).toBe(true);
		});
	});

	test("a non-default unverified version doesn't need the verified default's lockfile entry", async () => {
		await withMoldHost(async (host) => {
			// 2.41.0 has a builtin lockfile entry; 9.9.9 doesn't. Declaring the
			// default verified and a second, non-default instance unverified
			// must resolve `unverified` from the instance being acquired, not
			// from the default.
			moldToolchain("2.41.0", { default: true });
			moldToolchain("9.9.9", { unverified: true });

			await acquireMoldToolchain("9.9.9");

			const [download] = host.runs;
			expect(download.argv[2]).not.toContain("sha256sum");
		});
	});

	test("a non-default verified version still requires a lockfile entry even when the default is unverified", async () => {
		await withMoldHost(async (host) => {
			moldToolchain("2.41.0", { default: true, unverified: true });
			moldToolchain("9.9.9");

			let message = null;
			try {
				await acquireMoldToolchain("9.9.9");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
		});
	});

	test("registers an odin-linker product exposing -linker:mold and a mold tool", async () => {
		await withMoldHost(async () => {
			installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
			const toolchain = moldToolchain("2.41.0");

			const linker = await productFor(toolchain, ODIN_LINKER);

			expect(await linker.flags()).toEqual(["-linker:mold"]);
			const tools = await linker.tools();
			expect(tools.length).toBe(1);
			expect(tools[0].name).toBe("mold");
		});
	});

	test("registers a rust-linker product exposing -fuse-ld=mold and a mold tool", async () => {
		await withMoldHost(async () => {
			installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
			const toolchain = moldToolchain("2.41.0");

			const linker = await productFor(toolchain, RUST_LINKER);

			expect(await linker.rustflags()).toEqual([
				"-C",
				"link-arg=-fuse-ld=mold",
			]);
			const tools = await linker.tools();
			expect(tools.length).toBe(1);
			expect(tools[0].name).toBe("mold");
		});
	});
});
