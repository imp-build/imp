// CargoPackage target class in a leaf module, so modules that //rules/rust
// itself imports for side effects (//rules/rust/test) can reference the class
// without a cycle back into //rules/rust.
import { Target, sourcesField } from "imp:core";
import { defaultRustToolchain } from "//rules/rust/toolchain";

export function normalize_deps(deps) {
	return deps
		.map((d) => (d && d.__imp ? d : d && d.target ? d.target : null))
		.filter(Boolean);
}

export class CargoPackage extends Target {
	static kind = "cargo-package";
	constructor({
		path = ".",
		bin,
		release = false,
		toolchain,
		cargoArgs = [],
		testArgs = [],
		testTools = [],
		deps = [],
		workspaceMember = false,
	}) {
		const bins = bin ? (Array.isArray(bin) ? bin : [bin]) : [];

		const toolchainHandle =
			toolchain && toolchain.__imp === true
				? toolchain
				: typeof toolchain === "string"
					? null
					: defaultRustToolchain();
		const toolchainVersion = typeof toolchain === "string" ? toolchain : null;

		const normalizedDeps = normalize_deps(deps);
		const normalizedTestTools = normalize_deps(testTools);
		const allDeps = [
			...(toolchainHandle ? [{ target: toolchainHandle, mode: "tool" }] : []),
			...normalizedDeps.map((target) => ({ target })),
			...normalizedTestTools.map((target) => ({ target, mode: "tool" })),
		];

		super({
			kind: CargoPackage.kind,
			attrs: {
				path,
				bins,
				release,
				cargoArgs,
				testArgs,
				testTools: normalizedTestTools,
				workspaceMember,
				...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
				...(toolchainVersion ? { toolchainVersion } : {}),
				...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
			},
			// Ownership tracking (compute_owned_files/allUnowned, see
			// //rules/rust/generate_build) — deliberately narrower than
			// sources() below: this crate owns only its own manifest and
			// sources, not sibling workspace members that a workspace-root
			// build merely needs to *see* to resolve path deps.
			sources: sourcesField({
				root: path,
				include: ["Cargo.toml", "Cargo.lock", "**/*.rs"],
				exclude: ["target/**"],
			}),
			deps: allDeps,
		});
	}
}
