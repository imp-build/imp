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

function fakeToolchain() {
	return tool(files({ root: "rules/rust", include: ["**/*"] }), {
		binDirs: ["."],
	});
}

function withWorkspace(fn) {
	return withFakeToolchainHost(async (host) => {
		host.setRunStdout("cargo metadata (workspace) .", JSON.stringify(METADATA));
		await fn(host, cargoWorkspaceExpansion(".", fakeToolchain()));
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

			let aFailed = false;
			try {
				await resolveHandles([expansion.get("crate-a", LINT)]);
			} catch (_) {
				aFailed = true;
			}
			expect(aFailed).toBe(true);

			// crate-b shares the same clippy run (already resolved above) but has
			// no attributed diagnostics, so it must resolve cleanly.
			await resolveHandles([expansion.get("crate-b", LINT)]);
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
			globalThis.__host_run = async (opts) => {
				const result = await real(opts);
				return { ...result, exitCode: 1 };
			};
			let failed = false;
			try {
				await resolveHandles([expansion.get("crate-a", LINT)]);
			} catch (_) {
				failed = true;
			} finally {
				globalThis.__host_run = real;
			}
			expect(failed).toBe(true);
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
