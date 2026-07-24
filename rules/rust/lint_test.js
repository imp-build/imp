import {
	describe,
	expect,
	test,
	withFakeDiff,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoPackage } from "//rules/rust";
import { cargoClippy } from "//rules/rust/lint";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";
import {
	gccToolchain,
	__resetGccToolchainStateForTest,
} from "//rules/c/gcc/toolchain";

function withRustHost(fn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("rust lint", () => {
	test("cargoClippy runs cargo clippy with -D warnings against the manifest", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const result = await cargoClippy(pkg);

			expect(result.ok).toBe(true);
			const clippyRun = host.runs[host.runs.length - 1];
			expect(clippyRun.argv[0]).toBe("sh");
			expect(clippyRun.argv[2]).toContain("cargo clippy");
			expect(clippyRun.argv[2]).toContain("--no-deps");
			expect(clippyRun.argv[2]).toContain("-D warnings");
			expect(clippyRun.allowFailure).toBe(true);
		});
	});

	test("cargoClippy reports a nonzero exit as ok:false instead of throwing", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const originalRun = globalThis.__host_run;
			globalThis.__host_run = async (opts) => {
				host.runs.push(opts);
				return {
					stdout: "",
					stderr: "warning: unused variable\n",
					exitCode: 1,
				};
			};
			try {
				const result = await cargoClippy(pkg);
				expect(result.ok).toBe(false);
				expect(result.output).toContain("unused variable");
			} finally {
				globalThis.__host_run = originalRun;
			}
		});
	});

	test("cargoClippy fix mode adds --fix --allow-dirty --allow-no-vcs and declares source outputs", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			await withFakeDiff(
				[{ type: "modified", path: "rules/rust/example/src/main.rs" }],
				async () => {
					const result = await cargoClippy(pkg, { fix: true });
					expect(result.ok).toBe(true);
					expect(result.fixSupported).toBe(true);
					expect(result.fixApplied).toBe(true);
					expect(result.outputDigest).not.toBe(null);
				},
			);

			const clippyRun = host.runs[host.runs.length - 1];
			expect(clippyRun.argv[2]).toContain("--fix");
			expect(clippyRun.argv[2]).toContain("--allow-dirty");
			expect(clippyRun.argv[2]).toContain("--allow-no-vcs");
			expect(clippyRun.materialize).toBe(true);
			expect(Array.isArray(clippyRun.outputs)).toBe(true);
		});
	});

	test("cargoClippy fix mode still reports ok:false when unfixable warnings remain", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

			const originalRun = globalThis.__host_run;
			globalThis.__host_run = async (opts) => {
				host.runs.push(opts);
				return {
					stdout: "",
					stderr: "error: this lint can't be auto-fixed\n",
					exitCode: 1,
					outputDigest: "fake-digest",
				};
			};
			try {
				await withFakeDiff(
					[{ type: "modified", path: "rules/rust/example/src/main.rs" }],
					async () => {
						const result = await cargoClippy(pkg, { fix: true });
						expect(result.ok).toBe(false);
						expect(result.fixApplied).toBe(true);
						expect(result.output).toContain("can't be auto-fixed");
					},
				);
			} finally {
				globalThis.__host_run = originalRun;
			}
		});
	});

	// A workspaceMember crate's cargoClippy delegates to one shared, memoized
	// `cargo clippy --workspace` run per real workspace root
	// (runWorkspaceClippy, above) instead of its own per-crate invocation —
	// same setup as cargoTest's workspace doc-test path (see
	// fakeWorkspaceMetadata in //rules/rust/index_test.js). Unlike that
	// helper, this one points at `rules/rust/example` rather than
	// `crates/imp-store`: the rules-test sandbox only stages `rules/**`
	// (see test_product, //rules/imp/test), and cargoClippy — unlike
	// cargoTest's workspace path — globs its own crate's `.rs` files
	// (rust_file_sources) up front for every crate regardless of
	// workspaceMember, so the fixture path must be real within that sandbox.
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
						workspace_members: ["example-id"],
						packages: [
							{
								id: "example-id",
								name: "example",
								manifest_path: "/workspace/rules/rust/example/Cargo.toml",
								targets: [{ name: "hello", kind: ["bin"] }],
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

	test("cargoClippy fix mode on a workspace member adds --fix to the shared run and attributes changed files back by path", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const restore = fakeWorkspaceMetadata(host);
			host.setRunStdout("cargo clippy --fix --workspace .", "");

			const pkg = cargoPackage({
				bin: "hello",
				path: "rules/rust/example",
				workspaceMember: true,
			});

			await withFakeDiff(
				[
					{
						type: "modified",
						path: "/workspace/rules/rust/example/src/main.rs",
					},
				],
				async () => {
					const result = await cargoClippy(pkg, { fix: true });
					expect(result.ok).toBe(true);
					expect(result.fixSupported).toBe(true);
					expect(result.fixApplied).toBe(true);
				},
			);
			restore();

			const clippyRun = host.runs[host.runs.length - 1];
			expect(clippyRun.argv[2]).toContain("--fix");
			expect(clippyRun.argv[2]).toContain("--allow-dirty");
			expect(clippyRun.argv[2]).toContain("--allow-no-vcs");
			expect(clippyRun.materialize).toBe(true);
		});
	});
});
