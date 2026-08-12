// Declarative catalog and renderer for `imp init`. Keep project-specific
// knowledge here: the Rust host only validates this protocol, detects the
// declared file markers, renders checklists, and persists the returned text.
//
// A feature belongs in the catalog only if selecting it changes the rendered
// workspace. Every ruleset entrypoint imports the workflow modules it needs
// for its [SYMBOL]s, and goal() registers on module evaluation, so importing
// //rules/rust already registers fmt/lint/test/package. Rendering those
// workflow imports again would suggest a choice the workspace does not have.
// Only imports that enable something the group entrypoint does not are
// emitted, and every emitted specifier names a public entrypoint
// (docs/content/guide/rule-module-structure.md).

const VERSION = 1;

function feature(id, label, description) {
	return { id, label, description };
}

function toolchainWarning(platform) {
	if (platform.os === "linux" && platform.arch === "x86_64") return null;
	return (
		"The managed GCC link driver currently supports only linux/x86_64. " +
		"The workspace can still be initialized, but some builds may require " +
		"a platform-specific toolchain adjustment."
	);
}

export function catalog(context = {}) {
	const platform = context.platform || {};
	const gccWarning = toolchainWarning(platform);
	return {
		version: VERSION,
		groups: [
			{
				id: "c",
				label: "C/C++",
				description: "Native C and C++ targets",
				detection: {
					fileNames: ["CMakeLists.txt"],
					extensions: ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx"],
				},
				features: [
					feature("c.cmake", "CMake projects", "Enable managed CMake projects"),
					feature(
						"c.generate-build",
						"Generate BUILD files",
						"Enable declarations for unowned native sources",
					),
				],
				...(gccWarning ? { warning: gccWarning } : {}),
			},
			{
				id: "js",
				label: "JavaScript/TypeScript",
				description: "JavaScript and TypeScript source targets",
				detection: {
					fileNames: ["package.json"],
					extensions: ["js", "jsx", "ts", "tsx"],
				},
				features: [
					feature("js.fmt", "Format with Biome", "Enable fmt and fmt --check"),
				],
			},
			{
				id: "odin",
				label: "Odin",
				description: "Odin packages and tests",
				detection: { fileNames: [], extensions: ["odin"] },
				features: [
					feature(
						"odin.fmt",
						"Format with odinfmt",
						"Enable fmt and fmt --check",
					),
					feature(
						"odin.generate-build",
						"Generate BUILD files",
						"Enable declarations for unowned Odin sources",
					),
				],
				...(gccWarning ? { warning: gccWarning } : {}),
			},
			{
				id: "python",
				label: "Python",
				description: "Locked Python applications and tests",
				detection: {
					fileNames: ["pyproject.toml", "uv.lock"],
					extensions: ["py"],
				},
				features: [
					feature(
						"python.fmt",
						"Format with Ruff",
						"Enable fmt and fmt --check",
					),
					feature("python.lint", "Lint with Ruff", "Enable Ruff checks"),
				],
			},
			{
				id: "rust",
				label: "Rust",
				description: "Cargo packages and tests",
				detection: {
					fileNames: ["Cargo.toml"],
					extensions: ["rs"],
				},
				features: [
					feature(
						"rust.generate-build",
						"Generate BUILD files",
						"Enable declarations for unowned Cargo packages",
					),
				],
				...(gccWarning ? { warning: gccWarning } : {}),
			},
		],
	};
}

function quoteImports(imports) {
	return [...imports].sort().map((specifier) => `import "${specifier}";`);
}

export function render(context = {}) {
	const selected = new Set(context.selected || []);
	const imports = new Set();
	const declarations = [];
	const has = (id) => selected.has(id);

	// Group entrypoints: the target constructors a BUILD.js file calls, and the
	// modules that own each ruleset's configuration namespace. A config
	// declaration is only read from imp.workspace.js, so the group import has
	// to be here even when the workspace declares no targets of its own.
	if (has("c")) imports.add("//rules/c");
	if (has("js")) imports.add("//rules/js");
	if (has("odin")) imports.add("//rules/odin");
	if (has("python")) imports.add("//rules/python");
	if (has("rust")) imports.add("//rules/rust");

	// Extension entrypoints. Each one registers a facet its group entrypoint
	// does not, and pulls in the workflow module that facet needs.
	if (has("c.cmake")) imports.add("//rules/c/cmake");
	if (has("js.fmt")) imports.add("//rules/js/biome");
	if (has("odin.fmt")) imports.add("//rules/odin/odinfmt");
	// Ruff's two facets are independently selectable, so each has its own
	// entrypoint (rules/python/ruff/DOC.md). Both reach the Ruff toolchain
	// through //rules/python/ruff_graph; neither needs it named here.
	if (has("python.fmt")) imports.add("//rules/python/ruff/fmt");
	if (has("python.lint")) imports.add("//rules/python/ruff/lint");
	// //rules/c is the only group entrypoint that does not register its own
	// build generator; //rules/rust imports //rules/rust/generate_build and
	// //rules/odin registers inline.
	if (has("c.generate-build")) {
		imports.add("//rules/c/generate_build");
		declarations.push("export const cConfig = { buildGenerate: true };");
	}
	if (has("odin.generate-build")) {
		declarations.push("export const odinConfig = { buildGenerate: true };");
	}
	if (has("rust.generate-build")) {
		declarations.push("export const rustConfig = { buildGenerate: true };");
	}

	const header = [
		"// Generated by `imp init`.",
		"// Edit this file to change the workspace integrations.",
	];
	const importLines = quoteImports(imports);
	const sections = [header.join("\n")];
	if (importLines.length > 0) sections.push(importLines.join("\n"));
	if (declarations.length > 0) sections.push(declarations.join("\n"));
	return `${sections.join("\n\n")}\n`;
}
