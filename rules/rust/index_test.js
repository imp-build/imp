import { BUILD, FMT, LINT, PACKAGE, TEST, files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoPackage, cargoPackageHandles } from "//rules/rust";
import { nativeTool } from "//rules/imp/native-tool";
import {
	__resetGccToolchainStateForTest,
	gccToolchain,
	installGccToolchain,
} from "//rules/c/gcc";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";

// Every cargoPackage() call constructs a `cargo metadata` task eagerly
// (cargoWorkspaceExpansion()/cargoStandaloneExpansion() call metadataTask()
// synchronously, not lazily inside expand()'s create()), and
// toolchainInputs() needs a resolvable gcc link-driver for that construction
// regardless of whether the package ever builds a binary — "every [cargo]
// task... needs this, not just the compiling ones" per workspace_expansion.js's
// own cargoEnv() doc comment. So every test here needs *some* gcc default
// declared, even ones that never touch [BUILD]/[PACKAGE].
function withRustHost(fn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		gccToolchain("2025.08-1", { default: true, unverified: true });
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

function fakeGraphToolchain() {
	const binRoot = files({ root: "rules/rust", include: ["**/*"] });
	return {
		tool: tool(binRoot, { binDirs: ["."] }),
		cargoHomeTool: tool(binRoot, { binDirs: ["."] }),
		toolchainId: "1.93.0-x86_64-unknown-linux-gnu",
		version: "1.93.0",
	};
}

// A fully fake gcc link-driver handle, sidestepping gccGraphToolchain()'s
// real download+install task chain entirely — the fake host's mocked run()
// doesn't materialize a real CAS artifact for a graph output.artifact() (see
// resolveIgnoringArtifactValidation()'s doc comment below for the same
// limitation), so fully resolving a *real* gcc install task isn't possible
// under this harness; mirrors fakeGraphToolchain()'s own avoidance of
// rustGraphToolchain()'s real acquisition. gccRustLinkDriverEnv() only ever
// reads `.version` off this (used for a cacheGet() lookup, not the `.tool`
// handle itself — see that function's docstring in //rules/c/gcc for why),
// so the caller must installGccToolchain(version, ...) to seed that lookup.
function fakeGccGraphToolchain(version = "2025.08-1") {
	const binRoot = files({ root: "rules/c/gcc", include: ["**/*"] });
	return { tool: tool(binRoot, { binDirs: ["bin"] }), version };
}

async function resolveHandles(handles) {
	const roots = handles.map((handle, index) => ({
		address: `root${index}`,
		handleId: handle.__graph_id,
	}));
	return globalThis.__imp_execute_graph_handles(
		JSON.stringify(roots),
		JSON.stringify({}),
	);
}

describe("graph-native cargoPackage", () => {
	test("omits [BUILD]/[PACKAGE] for a lib-only package but always exposes [LINT]/[FMT]/[TEST]", () => {
		return withRustHost(() => {
			const pkg = cargoPackage({
				path: "crates/lib-only",
				toolchain: fakeGraphToolchain(),
			});
			expect(LINT in pkg).toBe(true);
			expect(FMT in pkg).toBe(true);
			expect(TEST in pkg).toBe(true);
			expect(BUILD in pkg).toBe(false);
			expect(PACKAGE in pkg).toBe(false);
		});
	});

	test("exposes [BUILD]/[PACKAGE] as a facet object keyed by bin name when bin is declared", () => {
		return withRustHost(() => {
			const pkg = cargoPackage({
				path: "rules/rust/example",
				bin: "hello",
				toolchain: fakeGraphToolchain(),
			});
			expect(BUILD in pkg).toBe(true);
			expect(PACKAGE in pkg).toBe(true);
			expect(pkg[BUILD].hello.__imp_graph_handle).toBe(true);
			expect(pkg[PACKAGE].hello.__imp_graph_handle).toBe(true);
		});
	});

	// The fake host's mocked run() doesn't actually materialize a CAS
	// artifact for a declared output.file()/output.artifact() — no test in
	// this repo's fake-host harness resolves an artifact-producing task
	// end-to-end (see workspace_expansion_test.js's TEST-facet tests, which
	// stop at construction for the same reason). exec.action() itself still
	// runs the real host `run()` call and validates its own `tools`/`env`/
	// `argv` before that later artifact-shape check fails, so `host.runs` is
	// populated and inspectable — these tests catch that expected, harness-
	// specific failure and assert on the recorded run() call instead of
	// resolution succeeding outright.
	async function resolveIgnoringArtifactValidation(handles) {
		try {
			await resolveHandles(handles);
		} catch (error) {
			if (
				!String(error.message || error).includes("must be an action artifact")
			) {
				throw error;
			}
		}
	}

	test("cargo build invokes cargo via the graph-native gcc link-driver bridge (kache stays legacy)", () => {
		return withRustHost(async (host) => {
			installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
			const pkg = cargoPackage({
				path: "rules/rust/example",
				bin: "hello",
				toolchain: fakeGraphToolchain(),
			});
			// A fully fake linkDriver (see fakeGccGraphToolchain()'s doc comment)
			// — assigned before [BUILD] is first accessed below, so
			// linkerHandlesForSpec()'s lazy cache (rules/rust's crateBuildTask())
			// picks it up instead of falling back to a real declared gcc default.
			pkg.spec.legacyToolchainHandle = {
				attrs: { linkDriver: fakeGccGraphToolchain() },
			};

			await resolveIgnoringArtifactValidation([pkg[BUILD].hello]);

			const buildRun = host.runs.find(
				(run) => run.display === "cargo build rules/rust/example",
			);
			expect(buildRun).toBeTruthy();
			expect(buildRun.argv[0]).toBe("sh");
			// -C linker=<real absolute named-cache path> comes from
			// gccRustLinkDriverEnv() — never a sandbox-relative exec.tool()
			// alias, which breaks in practice (see that function's docstring in
			// //rules/c/gcc for the confirmed failure and reasoning).
			expect(buildRun.argv).toContain(
				"-C linker=/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/clang",
			);
		});
	});

	test("a custom rustToolchain({ linkDriver }) resolves through the graph-native gcc bridge", () => {
		return withRustHost(async (host) => {
			installGccToolchain("2099.01-1", "/tmp/gcc-2099.01-1");
			const legacyToolchain = rustToolchain("1.93.0", {
				linkDriver: fakeGccGraphToolchain("2099.01-1"),
			});
			const pkg = cargoPackage({
				path: "rules/rust/example",
				bin: "hello",
				toolchain: fakeGraphToolchain(),
			});
			// linkerHandles is resolved lazily (and cached) the first time
			// [BUILD] is accessed (rules/rust's linkerHandlesForSpec()), so a
			// custom linkDriver has to be threaded in before that point — in real
			// usage via rustToolchain({ linkDriver }) passed as `toolchain`;
			// reassigning spec.legacyToolchainHandle here mirrors that same
			// construction-time contract for this fake-toolchain test setup,
			// which otherwise bypasses resolveToolchain()'s legacy branch
			// entirely (see fakeGraphToolchain()).
			pkg.spec.legacyToolchainHandle = legacyToolchain;

			await resolveIgnoringArtifactValidation([pkg[BUILD].hello]);

			const buildRun = host.runs.find(
				(run) => run.display === "cargo build rules/rust/example",
			);
			expect(buildRun).toBeTruthy();
			expect(buildRun.argv).toContain(
				"-C linker=/cache/gcc-toolchains/2099.01-1/linux-x86_64/bin/clang",
			);
		});
	});

	test("[LINT]/[FMT] resolve through the shared workspace expansion for a workspaceMember crate", () => {
		return withRustHost(async (host) => {
			host.setRunStdout(
				"cargo metadata (workspace) .",
				JSON.stringify({
					workspace_root: "/sandbox/repo",
					workspace_members: ["hello 0.1.0"],
					packages: [
						{
							id: "hello 0.1.0",
							name: "hello",
							manifest_path: "/sandbox/repo/crates/hello/Cargo.toml",
						},
					],
				}),
			);
			host.setRunStdout("cargo clippy --workspace .", "");
			host.setRunStdout("cargo fmt --check --workspace .", "");

			const pkg = cargoPackage({
				path: "crates/hello",
				workspaceMember: true,
				toolchain: fakeGraphToolchain(),
			});

			// gcc's own graph-native install task can't fully resolve under this
			// harness either (same "must be an action artifact" limitation as
			// resolveIgnoringArtifactValidation() above) — tolerated the same way,
			// since this test's purpose is proving [LINT]/[FMT] wire up through
			// the shared workspace expansion, not exercising gcc's install task.
			await resolveIgnoringArtifactValidation([pkg[LINT], pkg[FMT]]);
		});
	});

	test("cargoPackageHandles() records every declared package's path and testTools, for generate_build's dedup check and workspace_expansion.js's per-crate testTools lookup", () => {
		return withRustHost(() => {
			const before = cargoPackageHandles().length;
			const tar = nativeTool("tar");
			cargoPackage({
				path: "crates/registry-fixture",
				workspaceMember: true,
				testTools: [tar],
				toolchain: fakeGraphToolchain(),
			});
			const handles = cargoPackageHandles();
			expect(handles.length).toBe(before + 1);
			const own = handles[handles.length - 1];
			expect(own.path).toBe("crates/registry-fixture");
			expect(own.testTools).toEqual([tar]);
		});
	});
});
