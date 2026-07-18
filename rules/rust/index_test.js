import { paths, pathsInDigest } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	cargoBuild,
	cargoPackage,
	cargoTest,
	declared_path,
	resources,
	rustToolEnv,
} from "//rules/rust";
import { resourcePackage } from "//rules/asset";
import { nativeTool } from "//rules/imp/native_tool";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";
import {
	__resetGccToolchainStateForTest,
	gccToolchain,
} from "//rules/c/gcc/toolchain";
import {
	__resetMoldToolchainStateForTest,
	moldToolchain,
} from "//rules/c/mold/toolchain";
import {
	__resetSccacheToolchainStateForTest,
	installSccacheToolchain,
	sccacheToolchain,
} from "//rules/rust/sccache/toolchain";

function withRustHost(platOrFn, maybeFn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		__resetMoldToolchainStateForTest();
		__resetSccacheToolchainStateForTest();
		const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
			__resetMoldToolchainStateForTest();
			__resetSccacheToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

async function withOptMode(value, fn) {
	const original = globalThis.__host_configuration;
	globalThis.__host_configuration = (namespace) =>
		namespace === "imp.mode"
			? JSON.stringify({ opt: value })
			: original(namespace);
	try {
		return await fn();
	} finally {
		globalThis.__host_configuration = original;
	}
}

describe("rust rules", () => {
	test("cargoPackage is valid without a bin name (lib-only package)", () => {
		const pkg = cargoPackage({});
		expect(pkg.attrs.bins).toEqual([]);
	});

	test("cargoPackage accepts a single bin name or an array", () => {
		const single = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
		expect(single.attrs.bins).toEqual(["hello"]);

		const multi = cargoPackage({ bin: ["a", "b"], toolchain: "1.93.0" });
		expect(multi.attrs.bins).toEqual(["a", "b"]);
	});

	test("cargoPackage keeps explicit string versions free of toolchain target deps", () => {
		const pkg = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
		expect(pkg.attrs.toolchainVersion).toBe("1.93.0");
		expect(pkg.attrs.toolchain).toBe(undefined);
	});

	test("cargoPackage uses the default Rust toolchain target when none is given", () => {
		return withRustHost(async () => {
			const toolchain = rustToolchain("1.93.0", {
				default: true,
				unverified: true,
			});
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
			expect(pkg.attrs.toolchain).toBe(toolchain);
		});
	});

	test("cargoBuild no-ops for a lib-only package (no bin)", async () => {
		await withRustHost(async (host) => {
			const pkg = cargoPackage({ path: "crates/imp-store" });
			const result = await cargoBuild(pkg);
			expect(result.outputPaths).toEqual([]);
			expect(host.runs.length).toBe(0);
		});
	});

	test("cargoBuild throws without a declared gcc toolchain default", async () => {
		await withRustHost(async () => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			let message = null;
			try {
				await cargoBuild(pkg);
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("gccToolchain() default");
		});
	});

	test("cargoBuild invokes cargo with the manifest path, target dir, and toolchain env", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const result = await cargoBuild(pkg);

			const path = declared_path(pkg, pkg.attrs.path);
			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv[0]).toBe("sh");
			expect(buildRun.argv).toContain(`${path}/Cargo.toml`);
			expect(buildRun.env).toContain("RUSTUP_HOME=.imp/tools/rustup-home");
			expect(buildRun.env).toContain("CARGO_HOME=.imp/tools/cargo-home");
			expect(buildRun.argv[2]).toContain('RUSTFLAGS="$rustflags"');
			expect(buildRun.env).toContain("CC=clang");
			expect(buildRun.argv).toContain("-C linker=clang");
			expect(result.outputPaths.length).toBe(1);
			expect(result.outputPaths[0].endsWith("/debug/hello")).toBe(true);
		});
	});

	test("cargoBuild passes --release and uses the release output dir", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({
				bin: "hello",
				release: true,
				path: "rules/rust/example",
			});

			const result = await cargoBuild(pkg);

			expect(result.outputPaths[0].endsWith("/release/hello")).toBe(true);
			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv).toContain("--release");
		});
	});

	test("cargoBuild follows the workspace release mode", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await withOptMode("release", async () => {
				const result = await cargoBuild(pkg);
				expect(result.outputPaths[0].endsWith("/release/hello")).toBe(true);
			});

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv).toContain("--release");
		});
	});
	test("cargoBuild uses native gcc as the linker on windows", async () => {
		await withRustHost({ os: "windows", arch: "x86_64" }, async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv).toContain("-C linker=gcc");
			expect(
				host.calls.some(
					(call) => call[0] === "nativeTool" && call[1] === "gcc",
				),
			).toBe(true);
		});
	});

	test("cargoTest throws without a declared gcc toolchain default", async () => {
		await withRustHost(async () => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			let message = null;
			try {
				await cargoTest(pkg);
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("gccToolchain() default");
		});
	});

	test("cargoTest invokes cargo test with the manifest path, target dir, and toolchain env", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoTest(pkg);

			const path = declared_path(pkg, pkg.attrs.path);
			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv[0]).toBe("sh");
			expect(testRun.argv[2]).toContain("cargo test");
			expect(testRun.argv).toContain(`${path}/Cargo.toml`);
			expect(testRun.argv).toContain("--workspace");
			expect(testRun.env).toContain("RUSTUP_HOME=.imp/tools/rustup-home");
			expect(testRun.env).toContain("CARGO_HOME=.imp/tools/cargo-home");
			expect(testRun.argv[2]).toContain('RUSTFLAGS="$rustflags"');
			expect(testRun.env).toContain("CC=clang");
			expect(testRun.argv).toContain("-C linker=clang");
			expect(testRun.impure).toBeFalsy();
			expect(testRun.outputs).toEqual([]);
		});
	});

	test("cargoTest does not retest the whole workspace from a member target", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({
				path: "crates/imp-store",
				workspaceMember: true,
			});

			await cargoTest(pkg);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv).not.toContain("--workspace");
		});
	});

	test("cargoTest passes through extra testArgs", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({
				bin: "hello",
				path: "rules/rust/example",
				testArgs: ["--", "--nocapture"],
			});

			await cargoTest(pkg);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv).toContain("--nocapture");
		});
	});

	test("cargoTest exposes declared native test tools on PATH", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const tar = nativeTool("tar");
			const gzip = nativeTool("gzip");
			const pkg = cargoPackage({
				bin: "hello",
				path: "rules/rust/example",
				testTools: [tar, gzip],
			});

			await cargoTest(pkg);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.tools.some((tool) => tool.name === "tar")).toBe(true);
			expect(testRun.tools.some((tool) => tool.name === "gzip")).toBe(true);
		});
	});

	test("cargoBuild adds mold backend flags and tool when the toolchain configures a linker", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const mold = moldToolchain("2.41.0", { default: true, unverified: true });
			const toolchain = rustToolchain("1.93.0", {
				default: true,
				unverified: true,
				linker: mold,
			});
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
			expect(pkg.attrs.toolchain).toBe(toolchain);

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv).toContain(
				"-C linker=clang -C link-arg=-fuse-ld=mold",
			);
			expect(buildRun.tools.some((t) => t.name === "mold")).toBe(true);
		});
	});

	test("cargoBuild honors an explicit non-default linkDriver over defaultGccToolchain()", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const explicitGcc = gccToolchain("2024.02-1", { unverified: true });
			rustToolchain("1.93.0", {
				default: true,
				unverified: true,
				linkDriver: explicitGcc,
			});
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(
				buildRun.tools.some((t) => t.key && t.key.startsWith("2024.02-1/")),
			).toBe(true);
		});
	});

	test("cargoBuild builds one output path per bin", async () => {
		await withRustHost(async () => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({
				bin: ["hello", "world"],
				path: "rules/rust/example",
			});

			const result = await cargoBuild(pkg);

			expect(result.outputPaths.length).toBe(2);
			expect(result.outputPaths[0].endsWith("/debug/hello")).toBe(true);
			expect(result.outputPaths[1].endsWith("/debug/world")).toBe(true);
		});
	});

	test("cargoBuild wires RUSTC_WRAPPER/SCCACHE_DIR when the toolchain configures sccache", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			installSccacheToolchain("0.10.0", "/tmp/sccache-0.10.0");
			const sccache = sccacheToolchain("0.10.0", { unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true, sccache });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.env).toContain("RUSTC_WRAPPER=sccache");
			expect(buildRun.env.some((e) => e.startsWith("SCCACHE_DIR="))).toBe(true);
			expect(buildRun.tools.some((t) => t.name === "sccache")).toBe(true);
			expect(
				host.calls.some(
					(call) => call[0] === "workerStart" && call[1] === "sccache",
				),
			).toBe(true);
			// RUSTUP_HOME/CARGO_HOME must be real, stable absolute paths (not
			// sandbox-relative "tool" mount aliases) when sccache is active —
			// see rustToolEnv()'s doc comment for why.
			expect(
				buildRun.env.some((e) => e.startsWith("RUSTUP_HOME=/cache/")),
			).toBe(true);
			expect(buildRun.env.some((e) => e.startsWith("CARGO_HOME=/cache/"))).toBe(
				true,
			);
			expect(
				buildRun.tools.some(
					(t) => t.name === "rustup-home" || t.name === "cargo-home",
				),
			).toBe(false);
		});
	});

	test("rustToolEnv uses sandbox-relative tool mounts without sccache, and absolute paths with it", () => {
		const toolSpec = {
			tools: [
				{ kind: "tool", name: "rustup-home" },
				{ kind: "tool", name: "cargo-home" },
			],
			rustupHome: ".imp/tools/rustup-home",
			cargoHome: ".imp/tools/cargo-home",
			rustupHomeAbs: "/cache/rustup-home/1.93.0/linux-x86_64",
			cargoHomeAbs: "/cache/cargo-home/1.93.0/linux-x86_64",
			toolchainId: "1.93.0-x86_64-unknown-linux-gnu",
		};

		const plain = rustToolEnv(toolSpec, false);
		expect(plain.tools).toEqual(toolSpec.tools);
		expect(plain.env).toEqual([
			"RUSTUP_HOME=.imp/tools/rustup-home",
			"CARGO_HOME=.imp/tools/cargo-home",
		]);

		const withSccache = rustToolEnv(toolSpec, true);
		expect(withSccache.tools).toEqual([]);
		expect(withSccache.env).toEqual([
			"RUSTUP_HOME=/cache/rustup-home/1.93.0/linux-x86_64",
			"CARGO_HOME=/cache/cargo-home/1.93.0/linux-x86_64",
			"PATH=/cache/rustup-home/1.93.0/linux-x86_64/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin:/cache/cargo-home/1.93.0/linux-x86_64/bin",
		]);
	});

	test("cargoBuild has no sccache env/tools without an opted-in toolchain", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.env.some((e) => e.startsWith("RUSTC_WRAPPER="))).toBe(
				false,
			);
			expect(buildRun.tools.some((t) => t.name === "sccache")).toBe(false);
		});
	});

	test("resources(pkg) is empty without a resource-package dep", async () => {
		const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
		expect(paths(await resources(pkg))).toEqual([]);
	});

	test("resources(pkg) with a resource-package dep includes its files", async () => {
		const assets = resourcePackage({
			path: "rules/rust",
			srcs: ["toolchain.js"],
		});
		const pkg = cargoPackage({
			bin: "hello",
			path: "rules/rust/example",
			deps: [assets],
		});
		const result = paths(await resources(pkg));
		expect(result).toContain("rules/rust/toolchain.js");
	});

	test("cargoBuild declares resource-package files as sandbox inputs", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const assets = resourcePackage({
				path: "rules/rust",
				srcs: ["toolchain.js"],
			});
			const pkg = cargoPackage({
				bin: "hello",
				path: "rules/rust/example",
				deps: [assets],
			});

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			// Glob-derived inputs are collapsed into a single {kind:"digest"}
			// entry per merged glob rather than one {kind:"file", path} entry
			// per match (see rules/odin/index_test.js's inputsIncludePath), so
			// "was this path fed into the sandbox" has to walk the digest.
			const includesPath = buildRun.inputs.some(
				(input) =>
					input.kind === "digest" &&
					pathsInDigest(input.digest).includes("rules/rust/toolchain.js"),
			);
			expect(includesPath).toBe(true);
		});
	});
});
