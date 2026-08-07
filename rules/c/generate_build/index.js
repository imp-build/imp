// Canonical C/C++/CMake BUILD-generation entrypoint (issue #31/#63 cutover).
// Auto-generates a ccLibrary()/ccBinary()/cmakeProject() declaration for
// every unowned CMakeLists.txt or C/C++ source directory in the workspace,
// for the `imp generate-build` goal. Mirrors rules/rust/generate_build's own
// split from //rules/rust — this file only adds the discovery/dedup pass
// around the graph-native factories declared in //rules/c and
// //rules/c/cmake.

import {
	allUnowned,
	defineConfigSchema,
	field,
	read_file,
	registerBuildRule,
} from "imp:core";

import { ccWorkloadSpecs, DEFAULT_CPP_HDRS, DEFAULT_CPP_SRCS } from "//rules/c";
import { cmakeProjectSpecs } from "//rules/c/cmake";
import { registerBuildGenerator } from "//rules/workflows/generate_build";

registerBuildRule({ rule: "ccLibrary", importFrom: "//rules/c" });
registerBuildRule({ rule: "ccBinary", importFrom: "//rules/c" });
registerBuildRule({ rule: "cmakeProject", importFrom: "//rules/c/cmake" });

/**
 * Declarative workspace configuration schema for C/C++.
 *
 * `buildGenerate` enables `imp goal generate-build` for unowned
 * CMakeLists.txt/source files (off by default).
 */
export const cConfigSchema = {
	buildGenerate: field.bool({ default: false }),
};

defineConfigSchema("c", cConfigSchema);

const DEFAULT_GENERATE_BUILD_EXCLUDES = [
	"**/.*/**",
	"**/build/**",
	"**/coverage/**",
	"**/dist/**",
	"**/obj/**",
	"**/target/**",
	"**/vendor/**",
];

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function dirname(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

function basename(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? path : path.slice(index + 1);
}

function build_file_for_dir(dir) {
	return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function sanitize_identifier(raw) {
	let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
	if (name.length === 0) name = "root";
	if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
	return name;
}

function target_name_for_dir(dir) {
	if (dir === ".") return "root";
	return sanitize_identifier(basename(dir));
}

function append_build_target(result, file, target) {
	if (!result[file]) result[file] = [];
	result[file].push(target);
}

function source_ext(path) {
	const match = /\.([^.\/]+)$/.exec(path);
	return match ? match[1].toLowerCase() : "";
}

function strip_c_comments_and_strings(input) {
	let out = "";
	let i = 0;
	let inString = false;
	let inChar = false;
	let inLineComment = false;
	let blockDepth = 0;

	while (i < input.length) {
		const ch = input[i];
		const next = input[i + 1];

		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out += "\n";
			} else {
				out += " ";
			}
			i++;
			continue;
		}

		if (blockDepth > 0) {
			if (ch === "/" && next === "*") {
				blockDepth++;
				out += "  ";
				i += 2;
			} else if (ch === "*" && next === "/") {
				blockDepth--;
				out += "  ";
				i += 2;
			} else {
				out += ch === "\n" ? "\n" : " ";
				i++;
			}
			continue;
		}

		if (!inString && !inChar && ch === "/" && next === "/") {
			inLineComment = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (!inString && !inChar && ch === "/" && next === "*") {
			blockDepth = 1;
			out += "  ";
			i += 2;
			continue;
		}

		if (inString || inChar) {
			out += ch === "\n" ? "\n" : " ";
			if (ch === "\\" && next !== undefined) {
				out += next === "\n" ? "\n" : " ";
				i += 2;
				continue;
			}
			if (inString && ch === '"') inString = false;
			if (inChar && ch === "'") inChar = false;
			i++;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += " ";
			i++;
			continue;
		}
		if (ch === "'") {
			inChar = true;
			out += " ";
			i++;
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

export function has_c_main_entrypoint(sourceText) {
	const text = strip_c_comments_and_strings(sourceText);
	return /(?:^|[^\w])main\s*\(/m.test(text);
}

function path_is_under(path, root) {
	const normalizedPath = normalize_workspace_path(path);
	const normalizedRoot = normalize_workspace_path(root);
	return normalizedRoot === "."
		? normalizedPath !== "."
		: normalizedPath === normalizedRoot ||
				normalizedPath.startsWith(`${normalizedRoot}/`);
}

function source_has_main(path) {
	if (!["c", "cc", "cpp", "cxx"].includes(source_ext(path))) return false;
	return has_c_main_entrypoint(read_file(path));
}

export async function generateBuild({
	root = ".",
	exclude = DEFAULT_GENERATE_BUILD_EXCLUDES,
} = {}) {
	const files = allUnowned({
		root,
		include: ["**/CMakeLists.txt", ...DEFAULT_CPP_SRCS, ...DEFAULT_CPP_HDRS],
		exclude,
	});

	const existingPaths = new Set([
		...ccWorkloadSpecs().map((spec) => normalize_workspace_path(spec.path)),
		...cmakeProjectSpecs().map((spec) => normalize_workspace_path(spec.path)),
	]);

	const cmakeDirs = Array.from(
		new Set(
			files.filter((path) => basename(path) === "CMakeLists.txt").map(dirname),
		),
	).sort();

	const result = {};
	for (const dir of cmakeDirs) {
		if (existingPaths.has(normalize_workspace_path(dir))) continue;
		append_build_target(result, build_file_for_dir(dir), {
			name: `${target_name_for_dir(dir)}_cmake`,
			rule: "cmakeProject",
			props: {},
		});
	}

	const cmakeRoots = cmakeDirs.filter(
		(dir) => !existingPaths.has(normalize_workspace_path(dir)),
	);
	const rawSources = files
		.filter((path) => ["c", "cc", "cpp", "cxx"].includes(source_ext(path)))
		.filter((path) => !cmakeRoots.some((root) => path_is_under(path, root)));

	const rawDirs = Array.from(new Set(rawSources.map(dirname))).sort();
	for (const dir of rawDirs) {
		if (existingPaths.has(normalize_workspace_path(dir))) continue;
		const dirSources = rawSources.filter((path) => dirname(path) === dir);
		const hasMain = dirSources.some(source_has_main);
		append_build_target(result, build_file_for_dir(dir), {
			name: target_name_for_dir(dir),
			rule: hasMain ? "ccBinary" : "ccLibrary",
			props: {},
		});
	}

	return result;
}

registerBuildGenerator({ namespace: "c", generate: generateBuild });
