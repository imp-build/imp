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
	parseDocTestOutput,
	resources,
	rustToolEnv,
} from "//rules/rust";
import { resourcePackage } from "//rules/asset";
import { nativeTool } from "//rules/imp/native_tool";
import {
	__resetRustToolchainStateForTest,
	installRustToolchain,
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
	__resetKacheToolchainStateForTest,
	installKacheToolchain,
	kacheToolchain,
} from "//rules/rust/kache/toolchain";

function withRustHost(platOrFn, maybeFn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		__resetMoldToolchainStateForTest();
		__resetKacheToolchainStateForTest();
		const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
			__resetMoldToolchainStateForTest();
			__resetKacheToolchainStateForTest();
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

async function withRustConfig(config, fn) {
	const original = globalThis.__host_configuration;
	globalThis.__host_configuration = (namespace) =>
		namespace === "rust" ? JSON.stringify(config) : original(namespace);
	try {
		return await fn();
	} finally {
		globalThis.__host_configuration = original;
	}
}

describe("rust rules", () => {
	test("cargoPackage is valid without a bin name (lib-only package)", () => {
		const pkg = cargoPackage({});
		expect(pkg.data.bins).toBe(null);
	});

	test("cargoPackage accepts a single bin name or an array", () => {
		const single = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
		expect(single.data.bins).toEqual(["hello"]);

		const multi = cargoPackage({ bin: ["a", "b"], toolchain: "1.93.0" });
		expect(multi.data.bins).toEqual(["a", "b"]);
	});

	test("cargoPackage preserves a doctest override", () => {
		expect(cargoPackage({ doctest: false }).data.doctest).toBe(false);
		expect(cargoPackage({}).data.doctest).toBe(undefined);
	});

	test("cargoPackage keeps explicit string versions free of toolchain target deps", () => {
		const pkg = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
		expect(pkg.data.toolchainVersion).toBe("1.93.0");
		expect(pkg.data.toolchain).toBe(undefined);
	});

	test("cargoPackage uses the default Rust toolchain target when none is given", () => {
		return withRustHost(async () => {
			const toolchain = rustToolchain("1.93.0", {
				default: true,
				unverified: true,
			});
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
			expect(pkg.data.toolchain).toBe(toolchain);
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

	test("cargoBuild throws without the GCC rule default", async () => {
		await withRustHost(async () => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			let message = null;
			try {
				await cargoBuild(pkg);
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("GCC rule default");
		});
	});

	test("cargoBuild invokes cargo with the manifest path, target dir, and toolchain env", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const result = await cargoBuild(pkg);

			const path = declared_path(pkg, pkg.data.path);
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

	test("cargoTest throws without the GCC rule default", async () => {
		await withRustHost(async () => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			let message = null;
			try {
				await cargoTest(pkg);
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("GCC rule default");
		});
	});

	test("cargoTest invokes cargo test with the manifest path, target dir, and toolchain env", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoTest(pkg);

			const path = declared_path(pkg, pkg.data.path);
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

	test("cargoTest skips a package with doctest disabled", async () => {
		await withRustHost(async (host) => {
			const pkg = cargoPackage({
				path: "rules/rust/example",
				doctest: false,
			});

			expect(await cargoTest(pkg)).toBe(null);
			expect(host.runs.length).toBe(0);
		});
	});

	test("cargoTest follows the workspace doctest default", async () => {
		await withRustHost(async (host) => {
			await withRustConfig({ doctest: false }, async () => {
				const pkg = cargoPackage({ path: "rules/rust/example" });

				expect(await cargoTest(pkg)).toBe(null);
				expect(host.runs.length).toBe(0);
			});
		});
	});

	// A workspaceMember crate's cargoTest delegates to one shared, memoized
	// `cargo test --doc --workspace --no-fail-fast` run per real workspace
	// root (runWorkspaceDocTests, //rules/rust) instead of its own per-crate
	// invocation — same collapsing rationale as runWorkspaceClippy
	// (//rules/rust/lint). These tests fake both `cargo metadata` calls that
	// path needs: `workspaceRootRelativeFor`'s "workspace closure" call
	// (finds *which* real workspace this crate belongs to) and
	// `wholeWorkspaceFor`'s "whole workspace" call (every real member, with
	// each one's lib/package name for attribution).
	function fakeWorkspaceMetadata(host) {
		const originalRun = globalThis.__host_run;
		globalThis.__host_run = async (opts) => {
			const closureMatch = /^cargo metadata \(workspace closure\) (.+)$/.exec(
				opts.display,
			);
			if (closureMatch) {
				const path = closureMatch[1];
				return {
					stdout: JSON.stringify({
						workspace_root: "/workspace",
						packages: [
							{
								name: path.split("/").pop(),
								manifest_path: `/workspace/${path}/Cargo.toml`,
								dependencies: [],
								targets: [],
							},
						],
						workspace_members: [],
					}),
					stderr: "",
					exitCode: 0,
				};
			}
			if (opts.display === "cargo metadata (whole workspace) .") {
				return {
					stdout: JSON.stringify({
						workspace_root: "/workspace",
						workspace_members: ["store-id", "imp-id"],
						packages: [
							{
								id: "store-id",
								name: "imp-store",
								manifest_path: "/workspace/crates/imp-store/Cargo.toml",
								targets: [{ name: "imp_store", kind: ["lib"] }],
							},
							{
								id: "imp-id",
								name: "imp",
								manifest_path: "/workspace/crates/imp/Cargo.toml",
								targets: [{ name: "imp", kind: ["bin"] }],
							},
						],
					}),
					stderr: "",
					exitCode: 0,
				};
			}
			return originalRun(opts);
		};
		return () => {
			globalThis.__host_run = originalRun;
		};
	}

	test("cargoTest runs one shared, workspace-wide doc-test invocation for a member target", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const restore = fakeWorkspaceMetadata(host);
			host.setRunStderr(
				"cargo test --doc --workspace .",
				"   Doc-tests imp_store\n",
			);

			const pkg = cargoPackage({
				path: "crates/imp-store",
				workspaceMember: true,
			});

			await cargoTest(pkg);
			restore();

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv[2]).toContain("cargo test");
			expect(testRun.argv[2]).toContain("--doc");
			expect(testRun.argv).toContain("--workspace");
			expect(testRun.argv[2]).toContain("--no-fail-fast");
			expect(testRun.argv).toContain("Cargo.toml");
			expect(
				testRun.argv.some((a) => a.startsWith("build/rust-doctest/")),
			).toBe(true);
		});
	});

	test("cargoTest excludes disabled packages from a shared workspace doc-test run", async () => {
		await withRustHost(async (host) => {
			// Use a distinct version so focused/repeated rule-test runs cannot
			// reuse another workspace-metadata fixture's persisted memo entry.
			rustToolchain("1.93.1", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const restoreMetadata = fakeWorkspaceMetadata(host);
			host.setRunStderr(
				"cargo test --doc -p imp-store .",
				"   Doc-tests imp_store\n",
			);
			cargoPackage({
				path: "crates/imp",
				doctest: false,
				workspaceMember: true,
			});
			const pkg = cargoPackage({
				path: "crates/imp-store",
				workspaceMember: true,
			});
			await cargoTest(pkg);
			restoreMetadata();

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv).toContain("-p");
			expect(testRun.argv).toContain("imp-store");
			expect(testRun.argv).not.toContain("--workspace");
		});
	});

	test("cargoTest passes for a member crate whose doc-tests ran and none of its own failed", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const restore = fakeWorkspaceMetadata(host);
			host.setRunStderr(
				"cargo test --doc --workspace .",
				"   Doc-tests imp_store\n",
			);

			const pkg = cargoPackage({
				path: "crates/imp-store",
				workspaceMember: true,
			});

			await cargoTest(pkg);
			restore();
		});
	});

	test("cargoTest fails for a member crate whose package name is in the shared run's failed-targets list", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const restore = fakeWorkspaceMetadata(host);
			host.setRunStderr(
				"cargo test --doc --workspace .",
				"   Doc-tests imp_store\n" +
					"error: doctest failed, to rerun pass `-p imp-store --doc`\n" +
					"error: 1 target failed:\n" +
					"    `-p imp-store --doc`\n",
			);

			const pkg = cargoPackage({
				path: "crates/imp-store",
				workspaceMember: true,
			});

			let message = null;
			try {
				await cargoTest(pkg);
			} catch (error) {
				message = error.message;
			}
			restore();

			expect(message).toContain("imp-store");
		});
	});

	test("cargoTest is a no-op for a bin-only member crate (no lib target)", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const restore = fakeWorkspaceMetadata(host);
			// Shared run's stderr never mentions "imp" at all — cargo
			// silently skips lib-less packages under `--workspace`.
			host.setRunStderr(
				"cargo test --doc --workspace .",
				"   Doc-tests imp_store\n",
			);

			const pkg = cargoPackage({
				path: "crates/imp",
				bin: "imp",
				workspaceMember: true,
			});

			await cargoTest(pkg);
			restore();
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
			expect(pkg.data.toolchain).toBe(toolchain);

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

	test("cargoBuild wires RUSTC_WRAPPER/KACHE_CACHE_DIR when the toolchain configures kache", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			installRustToolchain("1.93.0", "/tmp/rust-1.93.0");
			installKacheToolchain("0.11.0", "/tmp/kache-0.11.0");
			const kache = kacheToolchain("0.11.0", { unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true, kache });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.env).toContain("RUSTC_WRAPPER=kache");
			expect(buildRun.env.some((e) => e.startsWith("KACHE_CACHE_DIR="))).toBe(
				true,
			);
			expect(buildRun.env).toContain("KACHE_MAX_SIZE=4GiB");
			expect(buildRun.env).toContain("KACHE_LOCAL_ONLY=1");
			expect(buildRun.tools.some((t) => t.name === "kache")).toBe(true);
			// KACHE_BASE_DIR/--remap-path-prefix can't be real paths baked into
			// env:/argv: (the sandbox doesn't exist yet when those are hashed
			// into the task key) — they're resolved from $imp_sandbox_root,
			// captured by the script itself once it's actually running inside
			// the sandbox. See RustKacheWrapper.scriptPreamble()'s doc comment.
			expect(buildRun.argv[2]).toContain('imp_sandbox_root="$(pwd)"');
			expect(buildRun.argv[2]).toContain(
				'export KACHE_BASE_DIR="$imp_sandbox_root"',
			);
			expect(buildRun.argv[2]).toContain(
				'--remap-path-prefix="$imp_sandbox_root"=/imp-src',
			);
			const workerStartCall = host.calls.find(
				(call) => call[0] === "workerStart" && call[1] === "kache",
			);
			expect(workerStartCall).toBeTruthy();
			expect(workerStartCall[2].env).toContain("KACHE_LOCAL_ONLY=1");
			// RUSTUP_HOME/CARGO_HOME must be real, stable absolute paths (not
			// sandbox-relative "tool" mount aliases) when kache is active —
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

	test("rustToolEnv uses sandbox-relative tool mounts without kache, and absolute paths with it", () => {
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

		const withKache = rustToolEnv(toolSpec, true);
		expect(withKache.tools).toEqual([]);
		expect(withKache.env).toEqual([
			"RUSTUP_HOME=/cache/rustup-home/1.93.0/linux-x86_64",
			"CARGO_HOME=/cache/cargo-home/1.93.0/linux-x86_64",
			"PATH=/cache/rustup-home/1.93.0/linux-x86_64/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin:/cache/cargo-home/1.93.0/linux-x86_64/bin",
		]);
	});

	test("cargoBuild has no kache env/tools without an opted-in toolchain", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await cargoBuild(pkg);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.env.some((e) => e.startsWith("RUSTC_WRAPPER="))).toBe(
				false,
			);
			expect(buildRun.tools.some((t) => t.name === "kache")).toBe(false);
		});
	});

	test("resources(pkg) is empty without a resource-package dep", async () => {
		const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
		expect(paths(await resources(pkg))).toEqual([]);
	});

	test("resources(pkg) with a resource-package dep includes its files", async () => {
		const assets = resourcePackage({
			path: "rules/rust/toolchain",
			srcs: ["index.js"],
		});
		const pkg = cargoPackage({
			bin: "hello",
			path: "rules/rust/example",
			deps: [assets],
		});
		const result = paths(await resources(pkg));
		expect(result).toContain("rules/rust/toolchain/index.js");
	});

	test("cargoBuild declares resource-package files as sandbox inputs", async () => {
		await withRustHost(async (host) => {
			rustToolchain("1.93.0", { default: true, unverified: true });
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const assets = resourcePackage({
				path: "rules/rust/toolchain",
				srcs: ["index.js"],
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
					pathsInDigest(input.digest).includes("rules/rust/toolchain/index.js"),
			);
			expect(includesPath).toBe(true);
		});
	});
});

// Fixtures below are verbatim stderr captured from real `cargo test --doc
// --workspace --no-fail-fast` runs (cargo 1.94.1), not hand-written
// approximations — confirmed directly that cargo pads status verbs to a
// shared column (hence the varying leading whitespace) and that the
// "Doc-tests <name>" header uses the underscored lib/crate name while the
// `-p <name> --doc` failure references use the literal (hyphenated)
// package name.
describe("parseDocTestOutput", () => {
	test("all-passing run: every header is attempted, nothing failed", () => {
		const stderr =
			"    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s\n" +
			"   Doc-tests crate_a\n" +
			"   Doc-tests crate_d\n";
		const { attemptedLibNames, failedPackageNames } =
			parseDocTestOutput(stderr);
		expect([...attemptedLibNames]).toEqual(["crate_a", "crate_d"]);
		expect(failedPackageNames.size).toBe(0);
	});

	test("one failing package: attempted still includes it, and it's marked failed", () => {
		const stderr =
			"   Doc-tests crate_a\n" +
			"   Doc-tests crate_b\n" +
			"error: doctest failed, to rerun pass `-p crate_b --doc`\n" +
			"   Doc-tests crate_d\n" +
			"error: 1 target failed:\n" +
			"    `-p crate_b --doc`\n";
		const { attemptedLibNames, failedPackageNames } =
			parseDocTestOutput(stderr);
		expect([...attemptedLibNames]).toEqual(["crate_a", "crate_b", "crate_d"]);
		expect([...failedPackageNames]).toEqual(["crate_b"]);
	});

	test("package name (hyphenated) and lib name (underscored) are kept distinct", () => {
		const stderr =
			"   Doc-tests crate_e\n" +
			"error: doctest failed, to rerun pass `-p crate-e --doc`\n" +
			"   Doc-tests crate_a\n" +
			"   Doc-tests crate_b\n" +
			"error: doctest failed, to rerun pass `-p crate_b --doc`\n" +
			"   Doc-tests crate_d\n" +
			"error: 2 targets failed:\n" +
			"    `-p crate-e --doc`\n" +
			"    `-p crate_b --doc`\n";
		const { attemptedLibNames, failedPackageNames } =
			parseDocTestOutput(stderr);
		expect([...attemptedLibNames]).toEqual([
			"crate_e",
			"crate_a",
			"crate_b",
			"crate_d",
		]);
		expect([...failedPackageNames]).toEqual(["crate-e", "crate_b"]);
	});

	test("no doc-tests anywhere: empty sets, no crash", () => {
		const { attemptedLibNames, failedPackageNames } = parseDocTestOutput("");
		expect(attemptedLibNames.size).toBe(0);
		expect(failedPackageNames.size).toBe(0);
	});
});
