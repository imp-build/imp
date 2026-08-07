import { FMT, LINT, TEST, files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cargoWorkspaceExpansion } from "//rules/rust/workspace_expansion";

const WORKSPACE_ROOT = "/sandbox/repo";

function manifestPath(dir) {
	return dir === "."
		? `${WORKSPACE_ROOT}/Cargo.toml`
		: `${WORKSPACE_ROOT}/${dir}/Cargo.toml`;
}

const METADATA = {
	workspace_root: WORKSPACE_ROOT,
	workspace_members: ["a 0.1.0", "b 0.1.0"],
	packages: [
		{ id: "a 0.1.0", name: "crate-a", manifest_path: manifestPath("crates/a") },
		{ id: "b 0.1.0", name: "crate-b", manifest_path: manifestPath("crates/b") },
	],
};

function clippyMessage(dir, level) {
	return JSON.stringify({
		reason: "compiler-message",
		target: { src_path: `${WORKSPACE_ROOT}/${dir}/src/lib.rs` },
		manifest_path: manifestPath(dir),
		message: { level, rendered: `${dir}: a ${level}` },
	});
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

// A fully fake linkDriver, sidestepping gccGraphToolchain()'s real
// download+install task chain entirely — the fake host's mocked run()/
// nativeTool() calls don't materialize a real CAS artifact for a graph
// output.artifact() (see rules/rust/index_test.js's
// resolveBuildIgnoringArtifactValidation doc comment for the same
// limitation), so fully resolving a *real* gcc install task isn't possible
// under this harness; mirrors fakeToolchainSpec's own rust `toolchain` field,
// which avoids rustGraphToolchain()'s real acquisition the same way.
function fakeToolchainSpec() {
	const binRoot = files({ root: "rules/rust", include: ["**/*"] });
	return {
		toolchain: {
			tool: tool(binRoot, { binDirs: ["."] }),
			cargoHomeTool: tool(binRoot, { binDirs: ["."] }),
			toolchainId: "1.93.0-x86_64-unknown-linux-gnu",
			version: "1.93.0",
		},
		legacyToolchainHandle: null,
		linkerHandles: {
			gcc: { tool: tool(binRoot, { binDirs: ["."] }), version: "2025.08-1" },
			mold: null,
		},
	};
}

function withWorkspace(fn) {
	return withFakeToolchainHost(async (host) => {
		host.setRunStdout("cargo metadata (workspace) .", JSON.stringify(METADATA));
		await fn(host, cargoWorkspaceExpansion(".", fakeToolchainSpec()));
	});
}

describe("cargo workspace expansion", () => {
	test("shares one cargo clippy --workspace run across sibling crates' [LINT] roots", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo clippy --workspace .", "");

			await resolveHandles([
				expansion.get("crate-a", LINT),
				expansion.get("crate-b", LINT),
			]);

			const clippyRuns = host.runs.filter((run) =>
				run.display.startsWith("cargo clippy --workspace"),
			);
			expect(clippyRuns.length).toBe(1);
		});
	});

	test("attributes a warning to the crate it belongs to and leaves the other clean", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout(
				"cargo clippy --workspace .",
				[clippyMessage("crates/a", "warning")].join("\n"),
			);

			const [a] = await resolveHandles([expansion.get("crate-a", LINT)]);
			expect(a.result.ok).toBe(false);

			// crate-b shares the same clippy run (already resolved above) but has
			// no attributed diagnostics, so it must resolve cleanly.
			const [b] = await resolveHandles([expansion.get("crate-b", LINT)]);
			expect(b.result.ok).toBe(true);
		});
	});

	test("expansion.all(LINT) resolves every workspace member", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo clippy --workspace .", "");
			const all = expansion.all(LINT);
			await resolveHandles([all]);
		});
	});

	test("surfaces an unattributed workspace-wide clippy failure rather than swallowing it", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo clippy --workspace .", "");
			const real = globalThis.__host_run;
			// Only clippy's own run should fail here — `cargo metadata` still
			// needs to succeed first (expand()'s own construction depends on
			// it), so a blanket override would fail for an unrelated reason.
			globalThis.__host_run = async (opts) => {
				const result = await real(opts);
				if (opts.display && opts.display.startsWith("cargo clippy")) {
					return { ...result, exitCode: 1 };
				}
				return result;
			};
			let result;
			try {
				[result] = await resolveHandles([expansion.get("crate-a", LINT)]);
			} finally {
				globalThis.__host_run = real;
			}
			expect(result.result.ok).toBe(false);
		});
	});

	test("expansion.get(crateName, TEST, 'unit') resolves to a distinct graph handle per crate", () => {
		return withWorkspace(async (_host, expansion) => {
			const testA = expansion.get("crate-a", TEST, "unit");
			const testB = expansion.get("crate-b", TEST, "unit");
			expect(testA.__imp_graph_handle).toBe(true);
			expect(testB.__imp_graph_handle).toBe(true);
			expect(testA.__graph_id === testB.__graph_id).toBe(false);
		});
	});

	test("shares one cargo fmt --check --workspace run across sibling crates' [FMT] roots", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo fmt --check --workspace .", "");

			await resolveHandles([
				expansion.get("crate-a", FMT),
				expansion.get("crate-b", FMT),
			]);

			const fmtRuns = host.runs.filter((run) =>
				run.display.startsWith("cargo fmt --check --workspace"),
			);
			expect(fmtRuns.length).toBe(1);
		});
	});

	test("attributes an unformatted file to the crate it belongs to and leaves the other clean", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout(
				"cargo fmt --check --workspace .",
				`Diff in ${manifestPath("crates/a").replace("/Cargo.toml", "/src/lib.rs")} at line 1:\n-x\n+y\n`,
			);

			let aFailed = false;
			try {
				await resolveHandles([expansion.get("crate-a", FMT)]);
			} catch (_) {
				aFailed = true;
			}
			expect(aFailed).toBe(true);

			await resolveHandles([expansion.get("crate-b", FMT)]);
		});
	});

	test("shares one cargo test --doc --workspace run across sibling crates' doctest facets", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo test --doc --workspace .", "");

			await resolveHandles([
				expansion.get("crate-a", TEST, "doctests"),
				expansion.get("crate-b", TEST, "doctests"),
			]);

			const doctestRuns = host.runs.filter((run) =>
				run.display.startsWith("cargo test --doc --workspace"),
			);
			expect(doctestRuns.length).toBe(1);
		});
	});

	test("a bin-only crate (no lib target) has no doctests to attribute and resolves cleanly", () => {
		return withWorkspace(async (host, expansion) => {
			host.setRunStdout("cargo test --doc --workspace .", "");
			// crate-a's METADATA fixture declares no `targets`, so libNameFor()
			// returns null and the doctest facet must be a clean no-op.
			await resolveHandles([expansion.get("crate-a", TEST, "doctests")]);
		});
	});
});
