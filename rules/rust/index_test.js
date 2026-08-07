import { BUILD, FMT, LINT, PACKAGE, TEST, files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoPackage, cargoPackageHandles } from "//rules/rust";
import { nativeTool } from "//rules/imp/native-tool";
import { __resetGccToolchainStateForTest, gccToolchain } from "//rules/c/gcc";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";

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

function fakeGraphToolchain() {
	const binRoot = files({ root: "rules/rust", include: ["**/*"] });
	return {
		tool: tool(binRoot, { binDirs: ["."] }),
		cargoHomeTool: tool(binRoot, { binDirs: ["."] }),
		toolchainId: "1.93.0-x86_64-unknown-linux-gnu",
		version: "1.93.0",
	};
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
	async function resolveBuildIgnoringArtifactValidation(handle) {
		try {
			await resolveHandles([handle]);
		} catch (error) {
			if (
				!String(error.message || error).includes("must be an action artifact")
			) {
				throw error;
			}
		}
	}

	test("cargo build invokes cargo via the legacy linker/kache bridge", () => {
		return withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const pkg = cargoPackage({
				path: "rules/rust/example",
				bin: "hello",
				toolchain: fakeGraphToolchain(),
			});

			await resolveBuildIgnoringArtifactValidation(pkg[BUILD].hello);

			const buildRun = host.runs.find(
				(run) => run.display === "cargo build rules/rust/example",
			);
			expect(buildRun).toBeTruthy();
			expect(buildRun.argv[0]).toBe("sh");
		});
	});

	test("exec.action()'s legacy tool-spec passthrough (PR 3a) reaches the sandbox for a custom linker toolchain", () => {
		return withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			const linker = gccToolchain("2025.08-1", { unverified: true });
			const legacyToolchain = rustToolchain("1.93.0", { linkDriver: linker });
			const pkg = cargoPackage({
				path: "rules/rust/example",
				bin: "hello",
				toolchain: fakeGraphToolchain(),
			});
			// Manually attach the legacy toolchain handle the way resolveToolchain()
			// would if `toolchain` had been the legacy handle itself — exercised
			// directly here to isolate the exec.action() legacy-tool-spec bridge
			// (PR 3a) from rustGraphToolchain()'s own real acquisition flow, which
			// this fake toolchain deliberately bypasses (see fakeGraphToolchain()).
			pkg.spec.legacyToolchainHandle = legacyToolchain;

			await resolveBuildIgnoringArtifactValidation(pkg[BUILD].hello);

			const buildRun = host.runs.find(
				(run) => run.display === "cargo build rules/rust/example",
			);
			expect(buildRun).toBeTruthy();
			expect(buildRun.tools.length > 0).toBe(true);
		});
	});

	test("[LINT]/[FMT] resolve through the shared workspace expansion for a workspaceMember crate", () => {
		return withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
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

			await resolveHandles([pkg[LINT], pkg[FMT]]);
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
