// Rust formatting: unlike odinfmt (rules/odin/odinfmt), rustfmt has a native
// `--check` mode, so check mode doesn't need the digest-diff workaround — a
// nonzero exit from `cargo fmt --check` is enough for run() to fail the
// product, which fmtGoal (rules/workflows/fmt_goal.js) already turns into a
// goal error. The write path still uses digestOf/diffDigests, the same
// generic before/after comparison odinFmt uses, to report an accurate count
// of files actually changed.

import {
	cargoPackageActionHandle,
	declared_path,
	rust_file_sources,
	rust_toolchain_version,
	sources,
} from "//rules/rust";
import { rustTool } from "//rules/rust/toolchain";
import { digestOf, diffDigests, output, paths, run } from "imp:core";

function cargoFmtEnv(toolSpec) {
	return [
		`RUSTUP_HOME=${toolSpec.rustupHome}`,
		`CARGO_HOME=${toolSpec.cargoHome}`,
	];
}

// Reformat a crate's own sources in place, or (when `check` is true) verify
// they're already formatted without writing anything back. `cargo fmt
// --check` exits nonzero on unformatted files, which run() surfaces as a
// thrown error — no per-file parsing needed.
export async function cargoFmt(handle, { check = false } = {}) {
	handle = cargoPackageActionHandle(handle);
	const rustSrcs = await rust_file_sources(handle);
	const files = paths(rustSrcs);
	if (files.length === 0) {
		return check ? { checked: 0 } : { formatted: 0 };
	}
	const path = declared_path(handle, handle.attrs.path || ".");
	const toolSpec = await rustTool(rust_toolchain_version(handle));

	// cargo needs Cargo.toml/Cargo.lock staged too, not just the .rs files
	// that get reformatted/materialized back.
	const { files: srcs } = await sources(handle);

	if (check) {
		await run({
			argv: [
				"sh",
				"-c",
				'cargo fmt --manifest-path "$1" --check',
				"cargo-fmt-check",
				`${path}/Cargo.toml`,
			],
			tools: toolSpec.tools,
			env: cargoFmtEnv(toolSpec),
			inputs: [srcs],
			display: `cargo fmt --check ${path}`,
		});

		return { checked: files.length };
	}

	const before = digestOf(rustSrcs);

	const result = await run({
		argv: [
			"sh",
			"-c",
			'cargo fmt --manifest-path "$1"',
			"cargo-fmt",
			`${path}/Cargo.toml`,
		],
		tools: toolSpec.tools,
		env: cargoFmtEnv(toolSpec),
		inputs: [srcs],
		outputs: files.map((f) => output(f)),
		materialize: true,
		display: `cargo fmt ${path}`,
	});

	const changes = diffDigests(before, result.outputDigest);
	return { formatted: changes.length };
}
