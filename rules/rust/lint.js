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
// `--no-deps` is required for per-target lint results to mean anything in a
// workspace: without it, `cargo clippy -D warnings` also re-lints every
// workspace-local path dependency as part of building this crate, and a
// -D-warnings hit in any one of them becomes a hard compile error that masks
// this crate's own lint result entirely (and cascades to every other crate
// that transitively depends on it). `--no-deps` restricts clippy's lint pass
// to this target's own sources; dependencies still have to compile, just
// without also being re-linted here.

import {
	cargoInvocationScript,
	declared_path,
	resources,
	rust_file_sources,
	rust_toolchain_version,
	rustBuildCacheTools,
	rustLinkerTools,
	rustToolEnv,
	sources,
	withManifestOverride,
} from "//rules/rust";
import { defaultRustToolchain, rustTool } from "//rules/rust/toolchain";
import { paths, run } from "imp:core";

// Check a crate's own sources with clippy, without writing anything back.
// `--color=always` forces clippy's diagnostic colors even though stdout/
// stderr are piped rather than a tty.
export async function cargoClippy(handle) {
	const files = paths(await rust_file_sources(handle));
	if (files.length === 0) {
		return { ok: true, output: "" };
	}
	const toolSpec = await rustTool(rust_toolchain_version(handle));
	const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
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
	const { tools: rustTools, env: rustEnv } = rustToolEnv(toolSpec, kacheActive);

	const path = declared_path(handle, handle.attrs.path || ".");
	const { files: srcs, manifest } = await sources(handle);
	const resourceInputs = await resources(handle);

	const { script, arg: manifestArg } = withManifestOverride(
		cargoInvocationScript(
			'cargo clippy --manifest-path "$manifest" --target-dir "$target_dir" ' +
				'--no-deps --color=always "$@" -- -D warnings',
			{ scriptPreamble, kacheActive },
		),
		manifest,
	);

	const result = await run({
		argv: [
			"sh",
			"-c",
			script,
			"cargo-clippy",
			manifestArg,
			`${path}/Cargo.toml`,
			`build/rust-clippy/${path === "." ? "root" : path}`,
			rustflags,
		],
		tools: [...rustTools, ...linkerTools, ...cacheTools],
		env: [...rustEnv, ...linkerEnv, ...cacheEnv],
		inputs: [srcs, resourceInputs],
		allowFailure: true,
		display: `cargo clippy ${path}`,
	});

	return {
		ok: result.exitCode === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
	};
}
