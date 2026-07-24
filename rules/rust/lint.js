// Rust linting: clippy exits nonzero on any warning (we pass `-D warnings`),
// which is a normal lint outcome, not a build-system error — unlike fmt/test,
// the lint goal (rules/workflows/lint.js) runs every selected target to
// completion and reports a combined summary, so `run()` is called with
// `allowFailure: true` and the pass/fail decision is made from the returned
// exitCode instead of a thrown exception.
//
// Unlike cargo fmt (rules/rust/fmt.js), clippy actually compiles the crate
// (including running build scripts), so it needs the same linker/build-cache
// toolchain wiring as cargoBuild/cargoTest (rules/rust/index.js) — a bare
// rustTool() isn't enough; the hermetic sandbox has no system `cc`.
//
// A `workspaceMember` crate's lint runs as one shared, memoized
// `cargo clippy --workspace` invocation per real workspace root (see
// runWorkspaceClippy below and wholeWorkspaceFor's docstring in
// //rules/rust/workspace_closure) instead of one cargo invocation per
// crate: most crates' own dependency closures already cover most or all of
// a typical workspace anyway (confirmed against this repo: 8 of 9 crates),
// so per-crate `--no-deps` scoping bought little isolation in practice, and
// it required synthesizing a narrowed manifest that fought `--locked` over
// harmless lockfile trims.
//
// The shared run deliberately does NOT pass `-D warnings` to cargo itself
// (unlike the standalone path below) — confirmed directly: with
// `--workspace` selecting every member as its own clippy target, `-D
// warnings` promotes a warning to a hard compile *error*, which (same as a
// real compile error) stops that crate's artifact from being produced at
// all, silently starving every crate that depends on it of any diagnostic
// whatsoever in that run (not "warned", not "failed" — just never reached).
// That's a strictly worse per-crate signal than before. Instead,
// `--message-format=json` is parsed for each crate's own attributed
// `compiler-message`s, and *we* decide pass/fail per crate from their
// levels — nothing ever hard-fails to compile just because of a lint, so
// every reachable crate still gets its own real diagnostic set regardless
// of what a sibling crate's lints look like.
//
// A standalone crate (no `workspaceMember`) has no workspace to share a
// run with, so it keeps the simple per-crate `cargo clippy --no-deps --
// -D warnings` invocation — no cascading risk there, since `--no-deps`
// means its path-dependencies (other standalone crates) are always
// plain-compiled, never themselves clippy-driven, in this invocation.

import {
	cargoInvocationScript,
	declared_path,
	resources,
	resourcesForDirs,
	rust_file_sources,
	rust_toolchain_version,
	rustBuildCacheTools,
	rustLinkerTools,
	rustToolEnv,
	sources,
	wholeWorkspaceSources,
} from "//rules/rust";
import {
	wholeWorkspaceFor,
	workspaceRootRelativeFor,
} from "//rules/rust/workspace_closure";
import { defaultRustToolchain, rustTool } from "//rules/rust/toolchain";
import { digestOf, diffDigests, memo, output, paths, run } from "imp:core";

// Shared, memoized `cargo clippy --workspace` run for one real workspace
// root + toolchain configuration. A single cargo invocation is inherently
// one toolchain/rustflags/env for every member it covers, so this is only
// ever called with values consistent for a given real workspace — crates
// declaring genuinely different toolchains couldn't share one real
// `cargo build/clippy --workspace` invocation either, memoized or not.
// `fix` is part of the memo key (an extra argument), so a fix run and a
// plain-check run of the same workspace never collide in the memo cache.
const runWorkspaceClippy = memo(
	async function runWorkspaceClippy(
		workspaceRootRelative,
		toolchainVersion,
		toolchainHandle,
		fix,
	) {
		const toolSpec = await rustTool(toolchainVersion);
		const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const {
			tools: cacheTools,
			env: cacheEnv,
			scriptPreamble,
		} = await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			kacheActive,
		);

		const { files: srcs, memberDirs } = await wholeWorkspaceSources(
			workspaceRootRelative,
			toolchainVersion,
		);
		const resourceInputs = await resourcesForDirs(memberDirs);
		const before = fix ? digestOf(srcs) : null;

		const prefix =
			workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
		// No `-D warnings` here — see module docstring for why.
		const script = cargoInvocationScript(
			`cargo clippy ${fix ? "--fix --allow-dirty --allow-no-vcs " : ""}` +
				'--locked --workspace --message-format=json --manifest-path "$manifest" ' +
				'--target-dir "$target_dir" --color=always',
			{ scriptPreamble, kacheActive },
		);

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-clippy-workspace",
				`${prefix}Cargo.toml`,
				`build/rust-clippy/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`,
				rustflags,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			...(fix
				? { outputs: paths(srcs).map((f) => output(f)), materialize: true }
				: {}),
			allowFailure: true,
			display: `cargo clippy ${fix ? "--fix " : ""}--workspace ${workspaceRootRelative}`,
		});

		// One JSON object per line (compiler messages, artifact notifications,
		// build-script output, ...); anything that doesn't parse is non-JSON
		// diagnostic noise clippy still writes straight to stdout/stderr,
		// already covered by `result` for the raw-output fallback case below.
		const messages = [];
		for (const line of result.stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				messages.push(JSON.parse(trimmed));
			} catch (_) {
				// ignored — see above
			}
		}

		const changedPaths = fix
			? diffDigests(before, result.outputDigest).map((c) => c.path)
			: [];

		return { result, messages, changedPaths };
	},
	{ display: "workspace clippy {0}", level: "debug" },
);

// Check a crate's own sources with clippy, writing fixes back in place when
// `fix` is requested. `--color=always` forces clippy's diagnostic colors
// even though stdout/stderr are piped rather than a tty. `-D warnings` keeps
// promoting remaining warnings to errors even in fix mode, so a lint clippy
// can't machine-apply still reports `ok: false` after fixing what it could.
export async function cargoClippy(handle, { fix = false } = {}) {
	const rustSrcs = await rust_file_sources(handle);
	const files = paths(rustSrcs);
	if (files.length === 0) {
		return {
			ok: true,
			output: "",
			fixSupported: true,
			fixApplied: false,
			outputDigest: null,
		};
	}
	const path = declared_path(handle, handle.attrs.path || ".");
	const toolchainVersion = rust_toolchain_version(handle);
	const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();

	if (!handle.attrs.workspaceMember) {
		const toolSpec = await rustTool(toolchainVersion);
		const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const {
			tools: cacheTools,
			env: cacheEnv,
			scriptPreamble,
		} = await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			kacheActive,
		);
		const { files: srcs } = await sources(handle);
		const resourceInputs = await resources(handle);
		const before = fix ? digestOf(rustSrcs) : null;

		const script = cargoInvocationScript(
			`cargo clippy ${fix ? "--fix --allow-dirty --allow-no-vcs " : ""}` +
				'--locked --manifest-path "$manifest" --target-dir "$target_dir" ' +
				'--no-deps --color=always "$@" -- -D warnings',
			{ scriptPreamble, kacheActive },
		);

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-clippy",
				`${path}/Cargo.toml`,
				`build/rust-clippy/${path === "." ? "root" : path}`,
				rustflags,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			...(fix
				? { outputs: files.map((f) => output(f)), materialize: true }
				: {}),
			allowFailure: true,
			display: `cargo clippy ${fix ? "--fix " : ""}${path}`,
		});

		const changed = fix ? diffDigests(before, result.outputDigest) : [];
		return {
			ok: result.exitCode === 0,
			output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
			fixSupported: true,
			fixApplied: changed.length > 0,
			outputDigest: fix ? result.outputDigest : null,
		};
	}

	const workspaceRootRelative = await workspaceRootRelativeFor(
		path,
		toolchainVersion,
	);
	const { result, messages, changedPaths } = await runWorkspaceClippy(
		workspaceRootRelative,
		toolchainVersion,
		toolchainHandle,
		fix,
	);

	// Attribute the shared run's diagnostics back to this one crate by path
	// substring match on wherever cargo attached a source location
	// (`target.src_path` for compiler-message/artifact, `manifest_path`
	// otherwise) — absolute paths are sandbox-specific, so this can't match
	// against anything computed from a *different* run's sandbox, only
	// against this crate's own known repo-relative directory. The same
	// substring match attributes the shared fix run's changed-file digest
	// diff back to this crate.
	const ownMessages = messages.filter((msg) => {
		const p = (msg.target && msg.target.src_path) || msg.manifest_path;
		return typeof p === "string" && p.includes(`/${path}/`);
	});
	const ownDiagnostics = ownMessages
		.filter((msg) => msg.reason === "compiler-message" && msg.message)
		.map((msg) => msg.message.rendered)
		.filter(Boolean);
	const ownWarnOrError = ownMessages.some(
		(msg) =>
			msg.reason === "compiler-message" &&
			msg.message &&
			(msg.message.level === "warning" || msg.message.level === "error"),
	);
	const ownFixApplied = changedPaths.some((p) => p.includes(`/${path}/`));

	if (result.exitCode !== 0 && ownDiagnostics.length === 0) {
		// The shared run failed for a reason not attributed to this crate — a
		// real compile error elsewhere in the workspace (not a mere lint,
		// which never hard-fails the build here — see module docstring), so
		// this crate may never have been reached at all. Don't claim a clean
		// pass; surface the whole run so the actual problem is visible.
		return {
			ok: false,
			output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
			fixSupported: true,
			fixApplied: ownFixApplied,
			outputDigest: fix ? result.outputDigest : null,
		};
	}

	return {
		ok: !ownWarnOrError,
		output: ownDiagnostics.join("\n"),
		fixSupported: true,
		fixApplied: ownFixApplied,
		outputDigest: fix ? result.outputDigest : null,
	};
}
