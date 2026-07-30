import { productFor } from "imp:core";
import { RUST_LINK_DRIVER } from "//rules/rust/products";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetGccToolchainStateForTest,
	acquireGccToolchain,
	defaultGccToolchain,
	defaultGccToolchainVersion,
	gccCacheKey,
	gccBin,
	gccTool,
	gccToolchain,
	installGccToolchain,
} from "//rules/c/gcc";

function withGccHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetGccToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetGccToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("gcc toolchain", () => {
	test("declares a default gcc toolchain", () => {
		return withGccHost((host) => {
			const toolchain = gccToolchain("2025.08-1", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("2025.08-1");
			expect(
				gccCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("2025.08-1/linux-x86_64");
			expect(defaultGccToolchainVersion()).toBe("2025.08-1");
			expect(defaultGccToolchain()).toBe(toolchain);
			expect(host.calls[0][0]).toBe("namedCache");
		});
	});

	test("throws when no toolchain has been declared", async () => {
		await withGccHost(async () => {
			let message = null;

			try {
				await acquireGccToolchain("2025.08-1");
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no gcc toolchain declared");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withGccHost(async () => {
			gccToolchain("2025.08-1");
			let message = null;

			try {
				await gccBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no gcc toolchain version specified");
		});
	});

	test("installs and acquires a toolchain from the named cache", async () => {
		await withGccHost(async (host) => {
			const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });

			expect(installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1")).toBe(
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "gcc-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/gcc-2025.08-1",
				),
			).toBe(true);

			expect(await acquireGccToolchain("2025.08-1")).toBe(
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64",
			);
			expect(await gccBin("2025.08-1")).toBe(
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/x86_64-linux-gcc",
			);
			// Already cached, so no download/extract run() should have happened.
			expect(host.runs.length).toBe(0);
		});
	});

	test("describes the named-cache-backed gcc tool", async () => {
		await withGccHost(async () => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			gccToolchain("2025.08-1", { default: true });
			const tool = await gccTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("gcc-toolchain");
			expect(tool.cache).toBe("gcc-toolchains");
			expect(tool.key).toBe("2025.08-1/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe("bin");
		});
	});

	test("downloads, verifies, and installs via two sandboxed runs, writing a clang wrapper", async () => {
		await withGccHost(async (host) => {
			const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/c/gcc/gcc.lock",
				JSON.stringify({
					tool: "gcc",
					versions: {
						"2025.08-1": {
							"linux/x86_64": {
								url: "https://locked.example/x86-64--glibc--stable-2025.08-1.tar.xz",
								artifact: "x86-64--glibc--stable-2025.08-1.tar.xz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			gccToolchain("2025.08-1", { default: true });
			const path = await acquireGccToolchain("2025.08-1");

			expect(path).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/x86-64--glibc--stable-2025.08-1.tar.xz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");

			expect(install.argv[0]).toBe("sh");
			expect(
				install.argv.some((arg) =>
					arg.includes("x86-64--glibc--stable-2025.08-1.tar.xz"),
				),
			).toBe(true);
			expect(install.tools.some((t) => t.name === "xz")).toBe(true);
			expect(install.argv).toContain("clang");
			expect(install.argv).toContain("ar");
			expect(
				install.argv.some(
					(arg) =>
						typeof arg === "string" &&
						arg.includes("#!/bin/sh") &&
						arg.includes("x86_64-linux-gcc"),
				),
			).toBe(true);
			expect(
				install.argv.some(
					(arg) =>
						typeof arg === "string" &&
						arg.includes("#!/bin/sh") &&
						arg.includes("x86_64-buildroot-linux-gnu-ar"),
				),
			).toBe(true);
			expect(install.outputs[0].namedCache.name).toBe("gcc-toolchains");
			expect(install.outputs[0].namedCache.key).toBe(key);

			expect(
				host.calls.some(
					(call) => call[0] === "nativeTool" && call[1] === "curl",
				),
			).toBe(true);
		});
	});

	test("registers a rust-link-driver product exposing -C linker=clang and gcc/dirname tools", async () => {
		await withGccHost(async () => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const toolchain = gccToolchain("2025.08-1");

			const linkDriver = await productFor(toolchain, RUST_LINK_DRIVER);

			expect(await linkDriver.rustflags()).toEqual(["-C", "linker=clang"]);
			const tools = await linkDriver.tools();
			expect(tools.some((t) => t.name === "dirname")).toBe(true);
			expect(tools.some((t) => t.name === "gcc-toolchain")).toBe(true);
			expect(await linkDriver.env()).toEqual(["CC=clang"]);
		});
	});

	test("rust-link-driver's env() wraps CC/CXX with kache at a stable absolute path when kache is active", async () => {
		await withGccHost(async () => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const toolchain = gccToolchain("2025.08-1");

			const linkDriver = await productFor(toolchain, RUST_LINK_DRIVER);

			expect(await linkDriver.env(true)).toEqual([
				"CC=kache /cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
				"CXX=kache /cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/c++",
			]);
			// Still mounts gcc-toolchain/dirname as sandbox tools: rustc's own
			// link step resolves "clang" via PATH regardless of CC/kache.
			const tools = await linkDriver.tools();
			expect(tools.some((t) => t.name === "gcc-toolchain")).toBe(true);
		});
	});
});
