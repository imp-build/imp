// Illustrative proposal for the exported handle-graph API.
//
// Evaluating this module constructs immutable tasks and handles. Nothing
// executes until a workflow selects an exported root. Managed toolchain
// acquisition intentionally belongs to rules/imp (#34); this fixture models
// a pre-provisioned Rust tool directory as an ordinary source-backed tool.

import {
	BUILD,
	LINT,
	RUN,
	TEST,
	expand,
	file,
	files,
	output,
	semantic,
	task,
	tool,
} from "imp:core";

const manifest = file("Cargo.toml");
const lockfile = file("Cargo.lock");
const workspaceSources = files({
	include: ["crates/**/*.rs", "crates/**/Cargo.toml"],
});
const rust = tool(
	files({ root: ".tools/rust", include: ["**/*"] }),
	{ binDirs: ["bin"] },
);

// A task is one coarse graph node. JSON parsing and validation remain local
// implementation details; the independently reusable metadata is a value
// output handle.
const metadataTask = task({
	display: "cargo metadata",
	inputs: { manifest, lockfile, rust },
	outputs: { metadata: output.value() },

	async run(exec, input) {
		const result = await exec.action({
			argv: [
				exec.tool(input.rust, "cargo"),
				"metadata",
				"--locked",
				"--no-deps",
				"--format-version=1",
				"--manifest-path",
				exec.path(input.manifest),
			],
			inputs: [input.lockfile],
		});
		if (result.exitCode !== 0) throw new Error(result.stderr);
		return { metadata: JSON.parse(result.stdout) };
	},
});

function cargoPackage(pkg) {
	const packageRoot = pkg.manifest_path.replace(/\/Cargo\.toml$/, "");
	const sources = files({
		root: packageRoot,
		include: ["**/*.rs", "Cargo.toml"],
	});
	const outputName = pkg.name.replaceAll("-", "_");

	const compilation = task({
		display: `cargo build -p ${pkg.name}`,
		inputs: {
			manifest,
			lockfile,
			sources,
			rust,
			packageName: pkg.name,
		},
		outputs: { binary: output.artifact() },

		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.rust, "cargo"),
					"build",
					"--locked",
					"-p",
					input.packageName,
				],
				inputs: [input.manifest, input.lockfile, input.sources],
				outputs: {
					binary: output.file(`target/debug/${outputName}`),
				},
			});
			return { binary: result.outputs.binary };
		},
	});

	const result = {
		name: pkg.name,
		manifest: pkg.manifest_path,
		sources,
		outputs: compilation.outputs,
		[BUILD]: compilation.outputs.binary,
	};

	if (pkg.targets.some((target) => target.kind.includes("bin"))) {
		result[RUN] = task({
			display: `run ${pkg.name}`,
			cache: false,
			inputs: {
				binary: compilation.outputs.binary,
				args: semantic.args(),
			},
			async run(exec, input) {
				await exec.action({
					argv: [exec.path(input.binary), ...input.args],
					cache: false,
				});
			},
		});
	}

	return result;
}

// Expansion is a planning node. get() observes only one stable child while
// all() intentionally observes membership and every selected child.
const packages = expand({
	display: "expand Cargo packages",
	inputs: { metadata: metadataTask.outputs.metadata },
	create({ metadata }) {
		return Object.fromEntries(
			metadata.packages.map((pkg) => [pkg.name, cargoPackage(pkg)]),
		);
	},
});

function cargoWorkspaceTests({ sanitizer = null } = {}) {
	const suffix = sanitizer ?? "unit";
	const testBuild = task({
		display: `build Cargo workspace tests (${suffix})`,
		inputs: {
			manifest,
			lockfile,
			sources: workspaceSources,
			rust,
			sanitizer,
		},
		outputs: { binaries: output.artifact() },
		async run(exec, input) {
			const sanitizerArgs =
				input.sanitizer === null
					? []
					: [
							"--config",
							`build.rustflags=["-Zsanitizer=${input.sanitizer}"]`,
						];
			const result = await exec.action({
				argv: [
					exec.tool(input.rust, "cargo"),
					"test",
					"--locked",
					"--workspace",
					"--no-run",
					...sanitizerArgs,
				],
				inputs: [input.manifest, input.lockfile, input.sources],
				outputs: {
					binaries: output.directory(`target/tests/${suffix}`),
				},
			});
			return { binaries: result.outputs.binaries };
		},
	});

	return task({
		display: `run Cargo workspace tests (${suffix})`,
		cache: false,
		inputs: { binaries: testBuild.outputs.binaries },
		async run(exec, input) {
			await exec.action({
				argv: ["find", exec.path(input.binaries), "-type", "f", "-executable"],
				cache: false,
			});
		},
	});
}

function cargoClippy() {
	return task({
		display: "cargo clippy --workspace",
		inputs: {
			manifest,
			lockfile,
			sources: workspaceSources,
			rust,
			fix: semantic.flag("fix"),
		},
		async run(exec, input) {
			await exec.action({
				argv: [
					exec.tool(input.rust, "cargo"),
					"clippy",
					"--locked",
					"--workspace",
					...(input.fix ? ["--fix"] : []),
					"--",
					"-Dwarnings",
				],
				inputs: [input.manifest, input.lockfile, input.sources],
			});
		},
	});
}

export const workspace = {
	[BUILD]: packages.all(BUILD),
	[RUN]: packages.get("imp", RUN),
	[TEST]: {
		unit: cargoWorkspaceTests(),
		asan: cargoWorkspaceTests({ sanitizer: "address" }),
		tsan: cargoWorkspaceTests({ sanitizer: "thread" }),
	},
	[LINT]: {
		clippy: cargoClippy(),
	},
};

export default {
	[BUILD]: workspace[BUILD],
	[RUN]: workspace[RUN],
	[TEST]: workspace[TEST],
	[LINT]: workspace[LINT],
};
