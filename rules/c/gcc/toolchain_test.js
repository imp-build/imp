import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetGccToolchainStateForTest,
	defaultGccGraphToolchain,
	defaultGccToolchain,
	defaultGccToolchainVersion,
	gccCacheKey,
	gccBin,
	gccCMakeCompilerArgs,
	gccGraphToolchain,
	gccRustLinkDriverEnv,
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
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "gcc-toolchains",
				),
			).toBe(true);
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

	test("installGccToolchain publishes a local toolchain into the named cache", async () => {
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
		});
	});

	test("describes the named-cache-backed gcc tool", async () => {
		await withGccHost(async () => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
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

			expect(await gccBin("2025.08-1")).toBe(
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/x86_64-linux-gcc",
			);
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
			// The install script writes a wrapper per name; gcc and binutils use
			// different prefixes, both passed in as arguments.
			const script = install.argv[2];
			for (const wrapper of ["clang", "cc", "c++", "ar", "ranlib"]) {
				expect(script).toContain(`"${wrapper}:$`);
			}
			expect(script).toContain("#!/bin/sh");
			expect(install.argv).toContain("x86_64-linux");
			expect(install.argv).toContain("x86_64-buildroot-linux-gnu");
			expect(install.outputs[0].namedCache.name).toBe("gcc-toolchains");
			expect(install.outputs[0].namedCache.key).toBe(key);
			// The escape-hatch aliases exec .br_real directly (bypassing
			// Bootlin's toolchain-wrapper unsafe-path guard) with an explicit
			// --sysroot baked in, since .br_real has no wrapper to add it.
			for (const wrapper of [
				"clang-unsafe-paths",
				"cc-unsafe-paths",
				"c++-unsafe-paths",
			]) {
				expect(script).toContain(`"${wrapper}:$`);
			}
			expect(script).toContain(".br_real");
			expect(script).toContain("--sysroot");
			// bin-unsafe-paths/ mirrors bin/ under the same bare names ("clang"/
			// "cc"/"c++"/"ar"/"ranlib") — needed because Odin execs a program
			// literally named "clang" via PATH lookup to link, with no flag to
			// select a differently-named binary (see gccGraphTool()'s own
			// comment).
			expect(script).toContain("bin-unsafe-paths");
			// These are real scripts (not symlinks to "bin/*-unsafe-paths") that
			// reference the real binary via a "../bin/"-prefixed path relative to
			// their own "bin-unsafe-paths/" location — a symlink's own script
			// would resolve "$0" to the invoked (symlink) path, not the link
			// target, and fail to find .br_real.
			expect(script).toContain('"$out/bin-unsafe-paths/$name"');
			expect(script).toContain("/../bin/$target");
		});
	});

	test("gccCMakeCompilerArgs points at the plain aliases by default and the -unsafe-paths ones when unsafeSystemPaths is set", () => {
		return withGccHost(() => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const dir = "/cache/gcc-toolchains/2025.08-1/linux-x86_64";

			expect(gccCMakeCompilerArgs("2025.08-1")).toEqual([
				`-DCMAKE_C_COMPILER=${dir}/bin/clang`,
				`-DCMAKE_CXX_COMPILER=${dir}/bin/c++`,
				`-DCMAKE_RANLIB=${dir}/bin/ranlib`,
				`-DCMAKE_AR=${dir}/bin/ar`,
			]);
			expect(gccCMakeCompilerArgs("2025.08-1", true)).toEqual([
				`-DCMAKE_C_COMPILER=${dir}/bin/clang-unsafe-paths`,
				`-DCMAKE_CXX_COMPILER=${dir}/bin/c++-unsafe-paths`,
				`-DCMAKE_RANLIB=${dir}/bin/ranlib`,
				`-DCMAKE_AR=${dir}/bin/ar`,
			]);
		});
	});

	test("declares a graph-native gcc toolchain", () => {
		return withGccHost((host) => {
			gccToolchain("2025.08-1", { default: true });
			const graph = gccGraphToolchain("2025.08-1");

			expect(graph.tool.__imp_graph_handle).toBe(true);
			expect(graph.version).toBe("2025.08-1");
			expect(Object.isFrozen(graph)).toBe(true);
		});
	});

	test("graph toolchain construction does not touch the host run()", () => {
		return withGccHost((host) => {
			gccToolchain("2025.08-1", { default: true });
			gccGraphToolchain("2025.08-1");

			// Building the graph is pure node construction — nothing executes
			// until a workflow resolves the task, matching Odin/Rust's precedent.
			expect(host.runs.length).toBe(0);
		});
	});

	test("defaultGccGraphToolchain resolves the declared default, or null", () => {
		return withGccHost((host) => {
			expect(defaultGccGraphToolchain()).toBe(null);

			gccToolchain("2025.08-1", { default: true });
			const graph = defaultGccGraphToolchain();

			expect(graph.version).toBe("2025.08-1");
		});
	});

	test("gccRustLinkDriverEnv resolves the real absolute named-cache path (not a sandbox-relative one) and sets -C linker=<path>, CC=<path> in non-kache mode", () => {
		return withGccHost(() => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const exec = { path: () => "/unused" };

			const { rustflags, env, pathDirs } = gccRustLinkDriverEnv(
				exec,
				gccTool,
				"2025.08-1",
				false,
			);

			// A relative `-C linker=<path>` breaks in practice — rustc's own
			// linker subprocess isn't guaranteed to run with the sandbox root
			// as its cwd (confirmed by a real build failure — see this
			// function's docstring) — so both branches always use the real,
			// absolute, stable named-cache path, never exec.tool()'s
			// sandbox-mounted alias.
			expect(rustflags).toEqual([
				"-C",
				"linker=/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
			]);
			expect(env).toEqual([
				"CC=/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
			]);
			// pathDirs: cc-rs-driven build scripts look for "ar" via PATH with
			// no CC/CXX-shaped override available (confirmed missing by a real
			// build failure — see this function's docstring).
			expect(pathDirs).toEqual([
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin",
			]);
		});
	});

	test("gccRustLinkDriverEnv wraps CC/CXX with kache at the same stable absolute path when kache is active", () => {
		return withGccHost(() => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const gccTool = { __imp_graph_handle: true, name: "gcc-tool" };
			const exec = { path: () => "/unused" };

			const { rustflags, env, pathDirs } = gccRustLinkDriverEnv(
				exec,
				gccTool,
				"2025.08-1",
				true,
			);

			expect(rustflags).toEqual([
				"-C",
				"linker=/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
			]);
			expect(env).toEqual([
				"CC=kache /cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
				"CXX=kache /cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/c++",
			]);
			expect(pathDirs).toEqual([
				"/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin",
			]);
		});
	});
});

describe("gcc toolchain on windows", () => {
	const WIN = { os: "windows", arch: "x86_64" };
	const WIN_VERSION = "16.1.0posix-14.0.0-ucrt-r4";

	function withWindowsGccHost(fn) {
		return withGccHost(WIN, fn);
	}

	test("a plain OS-keyed version object resolves to the windows tag", () => {
		return withWindowsGccHost((host) => {
			const toolchain = gccToolchain(
				{ linux: "2025.08-1", windows: WIN_VERSION },
				{ default: true },
			);

			expect(toolchain.attrs.version).toBe(WIN_VERSION);
			expect(defaultGccToolchainVersion()).toBe(WIN_VERSION);
			expect(gccCacheKey(toolchain.attrs.version, WIN)).toBe(
				`${WIN_VERSION}/windows-x86_64`,
			);
		});
	});

	test("downloads, verifies, and installs via two sandboxed runs, aliasing gcc.exe/g++.exe by copy", () => {
		return withWindowsGccHost(async (host) => {
			host.addFile(
				"//rules/c/gcc/gcc-windows.lock",
				JSON.stringify({
					tool: "gcc-windows",
					versions: {
						[WIN_VERSION]: {
							"windows/x86_64": {
								url: "https://locked.example/winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip",
								artifact:
									"winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			gccToolchain(WIN_VERSION, { default: true });

			expect(await gccBin(WIN_VERSION)).toBe(
				`/cache/gcc-toolchains/${WIN_VERSION}/windows-x86_64/bin/gcc.exe`,
			);
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip",
			);
			expect(download.argv).toContain("deadbeef");

			expect(install.argv[0]).toBe("sh");
			const script = install.argv[2];
			// A zip, extracted with unzip — not tar, which on Windows can
			// silently resolve to Git-for-Windows' own GNU tar (no zip
			// support) instead of the OS's bsdtar, depending on PATH order.
			expect(script).toContain('"$unzip" -q');
			expect(script).not.toContain('"$tar"');
			// unzip has no --strip-components equivalent, so the wrapping
			// "mingw64/" directory is dropped via a staging dir + mv instead.
			expect(script).toContain('"$out.stage"');
			expect(script).toContain('"$mv" "$out.stage"/*/* "$out"/');
			// No Bootlin toolchain-wrapper to work around, so aliases are plain
			// file copies of the real binaries, not generated wrapper scripts.
			expect(script).toContain('"$cp"');
			expect(script).not.toContain("#!/bin/sh\\nexec");
			expect(script).not.toContain("chmod");
			for (const pair of ["clang:gcc", "cc:gcc", "c++-unsafe-paths:c++"]) {
				expect(script).toContain(`"${pair}"`);
			}
			expect(script).toContain("bin-unsafe-paths");
			expect(install.tools.some((t) => t.name === "unzip")).toBe(true);
			expect(install.tools.some((t) => t.name === "mv")).toBe(true);
			expect(install.tools.some((t) => t.name === "cp")).toBe(true);
			expect(install.outputs[0].namedCache.name).toBe("gcc-toolchains");
			expect(install.outputs[0].namedCache.key).toBe(
				`${WIN_VERSION}/windows-x86_64`,
			);
		});
	});

	test("gccCMakeCompilerArgs/gccRustLinkDriverEnv append .exe on windows", () => {
		return withWindowsGccHost(() => {
			installGccToolchain(WIN_VERSION, "/tmp/gcc-win");
			const gccTool = { __imp_graph_handle: true, name: "gcc-tool" };
			const exec = { path: () => "/unused" };
			const dir = `/cache/gcc-toolchains/${WIN_VERSION}/windows-x86_64`;

			expect(gccCMakeCompilerArgs(WIN_VERSION)).toEqual([
				`-DCMAKE_C_COMPILER=${dir}/bin/clang.exe`,
				`-DCMAKE_CXX_COMPILER=${dir}/bin/c++.exe`,
				`-DCMAKE_RANLIB=${dir}/bin/ranlib.exe`,
				`-DCMAKE_AR=${dir}/bin/ar.exe`,
				`-DCMAKE_ASM_NASM_COMPILER=${dir}/bin/nasm.exe`,
			]);

			const { rustflags, env, pathDirs } = gccRustLinkDriverEnv(
				exec,
				{ __imp_graph_handle: true, name: "gcc-tool" },
				WIN_VERSION,
				false,
			);
			expect(rustflags).toEqual(["-C", `linker=${dir}/bin/clang.exe`]);
			expect(env).toEqual([`CC=${dir}/bin/clang.exe`]);
			expect(pathDirs).toEqual([`${dir}/bin`]);
		});
	});
});

describe("gcc workspace lockfile selection", () => {
	const BUNDLED = "//rules/c/gcc/gcc.lock";

	function gccLock(version, sha256) {
		return JSON.stringify({
			tool: "gcc",
			versions: {
				[version]: {
					"linux/x86_64": {
						url: "https://locked.example/gcc.tar.xz",
						artifact: "gcc.tar.xz",
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
		await withGccHost(async (host) => {
			host.addFile(BUNDLED, gccLock("2025.08-1", "cafe"));
			gccToolchain("2025.08-1", { default: true });

			await gccBin("2025.08-1");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withGccHost(async (host) => {
			host.addFile("//locks/gcc.lock", gccLock("2024.05-1", "beef"));
			gccToolchain("2024.05-1", {
				default: true,
				lockfile: "//locks/gcc.lock",
			});

			await gccBin("2024.05-1");

			expect(readAddresses(host)).toContain("//locks/gcc.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("an os-keyed lockfile map selects the active platform's address", async () => {
		await withGccHost(async (host) => {
			host.addFile("//locks/gcc.lock", gccLock("2024.05-1", "beef"));
			gccToolchain("2024.05-1", {
				default: true,
				lockfile: { linux: "//locks/gcc.lock" },
			});

			await gccBin("2024.05-1");

			expect(readAddresses(host)).toContain("//locks/gcc.lock");
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withGccHost(async () => {
			gccToolchain("2024.05-1", {
				default: true,
				lockfile: "//locks/gcc.lock",
			});
			let message = null;
			try {
				await gccBin("2024.05-1");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/gcc.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withGccHost(() => {
			expect(() =>
				gccToolchain("2024.05-1", { lockfile: "locks/gcc.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withGccHost(async (host) => {
			const toolchain = gccToolchain("2024.05-1", {
				default: true,
				lockfile: "//locks/gcc.lock",
			});
			await host.resolve(toolchain[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/gcc.lock")).toBe(
				true,
			);
		});
	});
});
