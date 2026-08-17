// Canonical public entrypoint for shared archive-extraction helpers.
// Toolchains download with downloadToolArtifact (//rules/imp/lockfile) and compose
// this to unpack the artifact — usually straight into a named-cache-keyed
// directory output. Deliberately a plain helper, not a base-class pipeline:
// each toolchain owns its acquire flow and adds its own steps (wrapper
// scripts, cache seeding, installers) around it.
import { output, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";

// tar flags per real tar-family format; gzip/xz decompression must be
// explicit because tar can't sniff the compression of a piped or plain file
// argument everywhere. Zip archives are handled separately, by unzip, not
// tar: bsdtar can technically read a zip through plain "-xf", but Windows
// hosts two "tar"s that answer to the same bare name — Git-for-Windows'
// bundled MSYS/GNU tar (no zip support at all) and the OS's own bsdtar — and
// which one PATH search finds first is a host-configuration accident, not
// something a hermetic build should depend on (confirmed by a real failure:
// a machine with Git's tar ahead on PATH got "does not look like a tar
// archive" on a perfectly valid zip). unzip has no such competing
// alternative implementation to accidentally shadow it.
const FORMAT_FLAGS = {
	"tar.gz": "-xzf",
	"tar.xz": "-xJf",
	tar: "-xf",
};
const ZIP_FORMATS = new Set(["zip", "zip-unix"]);

/**
 * Native-tool names extractArchive's script needs for a format (callers merge
 * these into their declared core-tool set; the hermetic sandbox resolves no
 * ambient PATH).
 *
 * @param {string} format One of "tar.gz", "tar.xz", "tar", "zip", or
 *   "zip-unix" ("zip" and "zip-unix" are equivalent; both unpack via unzip).
 * @returns {string[]}
 */
export function extractArchiveTools(format) {
	if (ZIP_FORMATS.has(format)) {
		// "mv" is only exercised when stripComponents is set (see
		// runGraphArchiveExtraction's own comment on why unzip needs a staging
		// dir + mv rather than tar's built-in --strip-components), but the
		// tool set is derived from format alone, not per-call options.
		return ["mkdir", "unzip", "mv"];
	}
	const flags = FORMAT_FLAGS[format];
	if (!flags) {
		throw new Error(`unsupported archive format '${format}'`);
	}
	const decompress = { "tar.gz": ["gzip"], "tar.xz": ["xz"] }[format] ?? [];
	return ["mkdir", "tar", ...decompress];
}

async function runGraphArchiveExtraction(exec, inputs) {
	const isZip = ZIP_FORMATS.has(inputs.format);
	const flags = FORMAT_FLAGS[inputs.format];
	if (!flags && !isZip) {
		throw new Error(`unsupported archive format '${inputs.format}'`);
	}
	if (isZip && inputs.stripComponents && inputs.stripComponents !== 1) {
		throw new Error("zip extraction only supports stripComponents of 1");
	}
	const strip = inputs.stripComponents
		? ` --strip-components=${inputs.stripComponents}`
		: "";
	// unzip has no --strip-components equivalent, so stripping the archive's
	// wrapping top-level directory (e.g. Node's Windows release unpacking to
	// "node-v22.0.0-win-x64/...") means unpacking into a staging directory
	// first, then moving that single top-level directory's contents up.
	const command = isZip
		? inputs.stripComponents
			? 'mkdir -p "$2" "$2.stage" && unzip -q "$1" -d "$2.stage" && mv "$2.stage"/*/* "$2"'
			: 'mkdir -p "$2" && unzip -q "$1" -d "$2"'
		: `mkdir -p "$2" && tar ${flags} "$1" -C "$2"${strip}`;
	const tools = inputs.toolNames.map((_, index) => inputs[`tool${index}`]);
	const result = await exec.action({
		argv: [
			exec.tool(tools[0], "sh"),
			"-c",
			command,
			"extract-archive",
			exec.path(inputs.archive),
			inputs.dest,
		],
		tools,
		outputs: {
			directory: inputs.namedCache
				? output.directory(inputs.dest, { namedCache: inputs.namedCache })
				: output.directory(inputs.dest),
		},
		display: inputs.display,
	});
	return { directory: result.outputs.directory };
}

/**
 * Extract an archive into a directory, returning a directory artifact
 * handle immediately.
 *
 * This owns its own native tools (derived from `format`), so `tools` is
 * rejected. `namedCache` is accepted: a toolchain install has to publish its
 * extracted tree at a real, absolute, stable path, because callers outside
 * any sandbox need one — `imp @tool` executes the binary directly, and a
 * relative `-fuse-ld=<path>` breaks in practice (see moldRustLinkerEnv() in
 * //rules/c/mold).
 *
 * @param {object} opts
 * @param {object} opts.archive Graph handle for the downloaded archive
 *   (e.g. downloadToolArtifact()'s return value).
 * @param {string} opts.dest Sandbox-relative extraction directory.
 * @param {string} opts.format One of "tar.gz", "tar.xz", "tar", "zip", or
 *   "zip-unix" — the latter two are equivalent, both extracting via unzip.
 * @param {number} [opts.stripComponents] tar --strip-components value.
 * @param {{ name: string, key: string }} [opts.namedCache] Publish `dest` as
 *   a named-cache-keyed directory output (the toolchain-install shape).
 * @param {string} [opts.display] Task display label.
 * @returns {object} Directory artifact handle.
 */
export function extractArchive({
	archive,
	dest,
	format,
	stripComponents,
	namedCache,
	tools,
	display = "extract archive",
}) {
	if (tools !== undefined) {
		throw new Error("extractArchive owns its tools");
	}
	if (typeof dest !== "string" || dest.length === 0) {
		throw new Error("extractArchive(options) requires a non-empty dest");
	}
	// Validate construction-time policy before creating any graph nodes.
	extractArchiveTools(format);
	if (ZIP_FORMATS.has(format) && stripComponents && stripComponents !== 1) {
		throw new Error("zip extraction only supports stripComponents of 1");
	}
	const toolNames = ["sh", ...extractArchiveTools(format)];
	const uniqueToolNames = [...new Set(toolNames)];
	const inputs = {
		archive,
		dest,
		format,
		stripComponents: stripComponents ?? null,
		// Plain JSON, so it participates in the task key: publishing an
		// extraction into a named cache is part of what the task does, not an
		// invisible side effect two callers could disagree about.
		namedCache: namedCache ?? null,
		display,
		toolNames: uniqueToolNames,
	};
	for (const [index, name] of uniqueToolNames.entries()) {
		inputs[`tool${index}`] = nativeTool(name);
	}
	return task({
		inputs,
		outputs: { directory: output.artifact() },
		run: runGraphArchiveExtraction,
		display,
	}).outputs.directory;
}
