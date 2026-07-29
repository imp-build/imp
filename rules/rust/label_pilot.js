// Issue #76 pilot: a conventional, extensible Rust package built from the
// same label/goal primitives a BUILD file can use directly. This module is
// intentionally separate from cargoPackage(): the pilot must earn a broader
// migration before the existing target API changes.
import {
	artifact,
	build as attachBuild,
	digestOf,
	diffDigests,
	extensible,
	glob,
	label,
	logInfo,
	memo,
	output,
	output_path,
	packageGoal,
	paths,
	run,
	test as attachTest,
	writeWorkspace,
} from "imp:core";

import {
	build as cargoBuildPath,
	cargoInvocationScript,
	defaultRustToolchain,
	rustBuildCacheTools,
	rustLinkerTools,
	rustToolEnv,
} from "//rules/rust";
import { rustTool } from "//rules/rust/toolchain";

function normalizePath(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(
				`Rust pilot paths must stay within the workspace: ${path}`,
			);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function selectorScope(selector) {
	const address = selector.replace(/^\/\//, "");
	const colon = address.lastIndexOf(":");
	const scope = colon < 0 ? address : address.slice(0, colon);
	return scope || ".";
}

/** Resolve a factory-local path after the exported label has an address. */
export function cargoPackagePath(packageLabel, ctx) {
	const scope = selectorScope(ctx.selector);
	const local = normalizePath(packageLabel.data.path || ".");
	if (scope === ".") return local;
	if (local === ".") return scope;
	return normalizePath(`${scope}/${local}`);
}

function cargoSources(path) {
	return glob({
		root: path,
		include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	});
}

async function cargoTools() {
	const toolchainHandle = defaultRustToolchain();
	const version = toolchainHandle.attrs.version;
	const toolSpec = await rustTool(version);
	const kacheActive = !!toolchainHandle.attrs.kache;
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
	return {
		kacheActive,
		rustflags,
		scriptPreamble,
		tools: [...rustTools, ...linkerTools, ...cacheTools],
		env: [...rustEnv, ...linkerEnv, ...cacheEnv],
	};
}

export const cargoTestPath = memo(
	async function cargoTestPath(path) {
		const { kacheActive, rustflags, scriptPreamble, tools, env } =
			await cargoTools();
		const targetDir = output_path(`build/rust-label-test/${path}`);
		const script = cargoInvocationScript(
			'cargo test --locked --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
			{ scriptPreamble, kacheActive },
		);
		return run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-label-test",
				`${path}/Cargo.toml`,
				targetDir,
				rustflags,
			],
			tools,
			env,
			inputs: [cargoSources(path)],
			display: `cargo test ${path}`,
		});
	},
	{ display: "label cargo test {0}", level: "info" },
);

export async function cargoFmtPath(path, { check = false } = {}) {
	const toolchainHandle = defaultRustToolchain();
	const toolSpec = await rustTool(toolchainHandle.attrs.version);
	const rustSources = glob({ root: path, include: ["**/*.rs"] });
	const files = paths(rustSources);
	if (files.length === 0) {
		return check ? { checked: 0 } : { formatted: 0 };
	}
	const inputs = cargoSources(path);
	const env = [
		`RUSTUP_HOME=${toolSpec.rustupHome}`,
		`CARGO_HOME=${toolSpec.cargoHome}`,
	];
	if (check) {
		await run({
			argv: [
				"sh",
				"-c",
				'cargo fmt --manifest-path "$1" --check',
				"cargo-label-fmt-check",
				`${path}/Cargo.toml`,
			],
			tools: toolSpec.tools,
			env,
			inputs: [inputs],
			display: `cargo fmt --check ${path}`,
		});
		return { checked: files.length };
	}

	const before = digestOf(rustSources);
	const result = await run({
		argv: [
			"sh",
			"-c",
			'cargo fmt --manifest-path "$1"',
			"cargo-label-fmt",
			`${path}/Cargo.toml`,
		],
		tools: toolSpec.tools,
		env,
		inputs: [inputs],
		outputs: files.map((path) => output(path)),
		materialize: true,
		display: `cargo fmt ${path}`,
	});
	return { formatted: diffDigests(before, result.outputDigest).length };
}

export async function cargoClippyPath(path, fix) {
	const { kacheActive, rustflags, scriptPreamble, tools, env } =
		await cargoTools();
	const rustSources = glob({ root: path, include: ["**/*.rs"] });
	const files = paths(rustSources);
	if (files.length === 0) {
		return { ok: true, output: "", fixed: 0 };
	}
	const before = fix ? digestOf(rustSources) : null;
	const targetDir = output_path(`build/rust-label-clippy/${path}`);
	const script = cargoInvocationScript(
		`cargo clippy ${fix ? "--fix --allow-dirty --allow-no-vcs " : ""}` +
			'--locked --manifest-path "$manifest" --target-dir "$target_dir" "$@" -- -D warnings',
		{ scriptPreamble, kacheActive },
	);
	const result = await run({
		argv: [
			"sh",
			"-c",
			script,
			"cargo-label-clippy",
			`${path}/Cargo.toml`,
			targetDir,
			rustflags,
		],
		tools,
		env,
		inputs: [cargoSources(path)],
		...(fix
			? { outputs: files.map((path) => output(path)), materialize: true }
			: {}),
		allowFailure: true,
		display: `cargo clippy ${path}`,
	});
	const fixed = fix ? diffDigests(before, result.outputDigest).length : 0;
	return {
		ok: result.exitCode === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
		fixed,
	};
}

function distPath(selector) {
	const address = selector.replace(/^\/\//, "");
	const [dir, name] = address.split(":");
	return dir ? `dist/${dir}/${name}` : `dist/${name}`;
}

export const cargoPackage = extensible(function cargoPackage(opts = {}) {
	const packageLabel = label({ data: { path: opts.path || "." } });

	attachBuild(packageLabel, async function buildCargoPackage(ctx) {
		return cargoBuildPath(cargoPackagePath(packageLabel, ctx));
	});

	attachTest(packageLabel, async function testCargoPackage(ctx) {
		return cargoTestPath(cargoPackagePath(packageLabel, ctx));
	});

	packageGoal(packageLabel, async function packageCargoPackage(ctx) {
		const built = await cargoBuildPath(cargoPackagePath(packageLabel, ctx));
		if (!built.outputDigest || built.outputPaths.length === 0) return null;
		const packaged = artifact(built.outputDigest, { from: built.buildDir });
		const destination = distPath(ctx.selector);
		writeWorkspace(destination, packaged.digest, { from: packaged.from });
		logInfo(`${ctx.selector}#package -> ${destination}`);
		return packaged;
	});

	return packageLabel;
});
