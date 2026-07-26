// Declarative catalog and renderer for `imp init`. Keep project-specific
// knowledge here: the Rust host only validates this protocol, detects the
// declared file markers, renders checklists, and persists the returned text.

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
					feature("c.test", "Test", "Enable the test workflow"),
					feature("c.package", "Package", "Publish build outputs under dist/"),
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
					feature("odin.lint", "Lint", "Enable odin check -vet"),
					feature("odin.test", "Test", "Enable the test workflow"),
					feature(
						"odin.package",
						"Package",
						"Publish build outputs under dist/",
					),
					feature("odin.run", "Run", "Run a selected Odin package"),
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
					feature("python.test", "Test", "Enable the test workflow"),
					feature(
						"python.package",
						"Package",
						"Build and publish PEX applications",
					),
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
						"rust.fmt",
						"Format with rustfmt",
						"Enable fmt and fmt --check",
					),
					feature(
						"rust.lint",
						"Lint with Clippy",
						"Enable Clippy with warnings denied",
					),
					feature("rust.test", "Test", "Enable the test workflow"),
					feature(
						"rust.package",
						"Package",
						"Publish build outputs under dist/",
					),
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
	const any = (...ids) => ids.some(has);

	if (has("c")) imports.add("//rules/c");
	if (has("js")) imports.add("//rules/js");
	if (has("odin")) imports.add("//rules/odin");
	if (has("python")) imports.add("//rules/python");
	if (has("rust")) imports.add("//rules/rust");

	if (has("c.cmake")) {
		imports.add("//rules/c/cmake");
	}

	if (has("js.fmt")) {
		imports.add("//rules/js/biome");
	}

	if (has("odin.fmt")) {
		imports.add("//rules/odin/odinfmt");
	}
	if (any("python.fmt", "python.lint")) {
		imports.add("//rules/python/ruff_toolchain");
	}

	if (has("rust.fmt")) imports.add("//rules/rust/rustfmt");
	if (has("rust.lint")) imports.add("//rules/rust/clippy");
	if (has("python.fmt")) imports.add("//rules/python/ruff/fmt");
	if (has("python.lint")) imports.add("//rules/python/ruff/lint");

	if (any("js.fmt", "odin.fmt", "python.fmt", "rust.fmt")) {
		imports.add("//rules/workflows/fmt_goal");
	}
	if (any("odin.lint", "python.lint", "rust.lint")) {
		imports.add("//rules/workflows/lint_goal");
	}
	if (any("c.test", "odin.test", "python.test", "rust.test")) {
		imports.add("//rules/workflows/test");
	}
	if (any("c.package", "odin.package", "python.package", "rust.package")) {
		imports.add("//rules/workflows/package");
	}
	if (has("odin.run")) imports.add("//rules/workflows/run");
	if (any("c.generate-build", "odin.generate-build", "rust.generate-build")) {
		imports.add("//rules/workflows/generate_build");
	}

	if (has("c.generate-build")) {
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
