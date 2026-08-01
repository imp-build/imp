// Canonical public entrypoint for shared archive-extraction helpers.
// Toolchains download with downloadToolArtifact (//rules/imp/lockfile) and compose
// this to unpack the artifact — usually straight into a named-cache-keyed
// directory output. Deliberately a plain helper, not a base-class pipeline:
// each toolchain owns its acquire flow and adds its own steps (wrapper
// scripts, cache seeding, installers) around it.
import { output, output_path, run } from "imp:core";

// tar flags per archive format. Windows Git Bash ships bsdtar, which unpacks
// .zip through plain -xf; gzip/xz decompression must be explicit because tar
// can't sniff the compression of a piped or plain file argument everywhere.
const FORMAT_FLAGS = {
	"tar.gz": "-xzf",
	"tar.xz": "-xJf",
	tar: "-xf",
	// Windows' bsdtar can read zip files; Unix callers needing a zip must use
	// "zip-unix", which invokes the native unzip utility instead.
	zip: "-xf",
};

/**
 * Native-tool names extractArchive's script needs for a format (callers merge
 * these into their declared core-tool set; the hermetic sandbox resolves no
 * ambient PATH).
 *
 * @param {string} format One of "tar.gz", "tar.xz", "tar", "zip", or
 *   "zip-unix".
 * @returns {string[]}
 */
export function extractArchiveTools(format) {
	if (format === "zip-unix") {
		return ["mkdir", "unzip"];
	}
	const flags = FORMAT_FLAGS[format];
	if (!flags) {
		throw new Error(`unsupported archive format '${format}'`);
	}
	const decompress = { "tar.gz": ["gzip"], "tar.xz": ["xz"] }[format] ?? [];
	return ["mkdir", "tar", ...decompress];
}

/**
 * Extract a downloaded archive into a directory via run().
 *
 * @param {object} opts
 * @param {string} opts.archive Sandbox-relative path of the downloaded archive.
 * @param {string} opts.dest Sandbox-relative extraction directory.
 * @param {string} opts.format One of "tar.gz", "tar.xz", "tar", "zip", or
 *   "zip-unix". "zip" unpacks via `tar -xf` for Windows' bsdtar; use
 *   "zip-unix" for GNU/Linux and macOS, where it invokes `unzip` instead.
 * @param {number} [opts.stripComponents] tar --strip-components value.
 * @param {object[]} opts.tools Resolved native-tool specs covering
 *   extractArchiveTools(format) (plus `sh` on windows).
 * @param {{ name: string, key: string }} [opts.namedCache] Publish `dest` as
 *   a named-cache-keyed directory output (the toolchain-install shape).
 * @param {string} opts.display run() display label.
 * @returns {Promise<string>} The destination directory.
 */
export async function extractArchive({
	archive,
	dest,
	format,
	stripComponents,
	tools,
	namedCache,
	display,
}) {
	const flags = FORMAT_FLAGS[format];
	if (!flags && format !== "zip-unix") {
		throw new Error(`unsupported archive format '${format}'`);
	}
	if (format === "zip-unix" && stripComponents) {
		throw new Error("zip-unix extraction does not support stripComponents");
	}
	const strip = stripComponents ? ` --strip-components=${stripComponents}` : "";
	const command =
		format === "zip-unix"
			? 'mkdir -p "$2" && unzip -q "$1" -d "$2"'
			: `mkdir -p "$2" && tar ${flags} "$1" -C "$2"${strip}`;
	await run({
		argv: ["sh", "-c", command, "extract-archive", archive, dest],
		tools,
		inputs: [{ kind: "file", path: archive }],
		outputs: [
			output(output_path(dest), {
				kind: "directory",
				...(namedCache ? { namedCache } : {}),
			}),
		],
		materialize: true,
		display,
	});
	return dest;
}
