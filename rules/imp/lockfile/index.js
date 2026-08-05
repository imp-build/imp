// Canonical public entrypoint for toolchain-lockfile resolution and
// verified-download helpers.
//
// A tool lockfile (written by `imp goal gen-lockfiles`, see
// rules/workflows/lockfiles.js) pins per-version, per-platform download URL,
// artifact name, size, and SHA-256 for a toolchain. Lockfiles are additive —
// every version ever locked stays in the file, so downgrading to a
// previously locked version resolves without regeneration. Lockfiles are
// referenced by workspace *address* (`//rules/python/ruff-toolchain.lock`),
// resolved by readAddressedFile with the same precedence as module imports:
// a file under the workspace root wins, with imp's built-in rules tree as
// the fallback for `//rules/...` — so a lockfile checked in next to its rule
// module ships with the rule library, and a consumer overrides it by
// placing a file at the same address or pointing the toolchain at a
// different one.
//
// Miss policy: a missing lockfile, wrong tool, unlocked version, or absent
// platform entry throws (the actionable default), unless the toolchain was
// declared with `unverified: true`, which downgrades to a warning and an
// unverified download.
import {
	logWarn,
	output,
	output_path,
	readAddressedFile,
	run,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";

/**
 * Convert a lockfile address (`//a/b.lock`) to a workspace-relative path
 * (`a/b.lock`) — where gen-lockfiles writes it.
 *
 * @param {string} address
 * @returns {string}
 */
export function lockfileAddressToPath(address) {
	if (!address.startsWith("//")) {
		throw new Error(`lockfile address '${address}' must start with //`);
	}
	const rel = address.slice(2);
	if (
		rel.length === 0 ||
		rel.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(
			`lockfile address '${address}' must be a workspace-relative file path`,
		);
	}
	return rel;
}

/**
 * Resolve the lockfile entry pinning a toolchain artifact for a version and
 * platform.
 *
 * Returns `{ url, artifact, size?, sha256 }` on a match (`size` is absent in
 * entries migrated from pre-additive lockfiles). On any miss (no lockfile at
 * the address, tool mismatch, unlocked version, or no entry for the
 * platform): throws with a pointer to gen-lockfiles, or — if `unverified` —
 * warns and returns null so the caller falls back to an unverified download.
 *
 * @param {object} opts
 * @param {string} opts.address Lockfile address, e.g. "//rules/python/ruff-toolchain.lock".
 * @param {string} opts.tool Lockfile `tool` stem, e.g. "ruff-toolchain".
 * @param {string} opts.version
 * @param {{ os: string, arch: string }} opts.plat
 * @param {boolean} [opts.unverified=false]
 * @returns {{ url: string, artifact: string, size?: number, sha256: string }|null}
 */
export function resolveToolLockfile({
	address,
	tool,
	version,
	plat,
	unverified = false,
}) {
	return resolveToolLockfileContents({
		contents: readAddressedFile(address),
		address,
		tool,
		version,
		plat,
		unverified,
	});
}

function resolveToolLockfileContents({
	contents,
	address,
	tool,
	version,
	plat,
	unverified = false,
}) {
	const miss = (reason) => {
		const message =
			`${reason}; run \`imp goal gen-lockfiles\` to regenerate it, ` +
			`or declare the toolchain with \`unverified: true\` to skip verification`;
		if (unverified) {
			logWarn(`${message} (continuing unverified)`);
			return null;
		}
		throw new Error(message);
	};

	if (contents === null) {
		return miss(`no lockfile found at ${address} for ${tool} ${version}`);
	}
	let lock;
	try {
		lock = JSON.parse(contents);
	} catch (e) {
		return miss(`lockfile ${address} is not valid JSON (${e.message})`);
	}
	if (lock.tool !== tool) {
		return miss(`lockfile ${address} pins ${lock.tool}, not ${tool}`);
	}
	const versions = lock.versions || {};
	const perPlat = versions[version];
	if (!perPlat) {
		const locked = Object.keys(versions).join(", ") || "none";
		return miss(
			`lockfile ${address} has no entry for ${tool} ${version} (locked versions: ${locked})`,
		);
	}
	const entry = perPlat[`${plat.os}/${plat.arch}`];
	if (!entry || !entry.sha256 || !entry.url) {
		return miss(
			`lockfile ${address} has no entry for ${tool} ${version} on platform ${plat.os}/${plat.arch}`,
		);
	}
	return entry;
}

/**
 * Name of the SHA-256 checking native tool for a platform — `sha256sum`
 * everywhere it's stock (linux; windows via Git-for-Windows sh, the same
 * environment the curl/tar scripts already assume), `shasum` on macos.
 *
 * @param {{ os: string }} plat
 * @returns {string}
 */
export function shaToolName(plat) {
	return plat.os === "macos" ? "shasum" : "sha256sum";
}

/**
 * Native-tool names the lockedDownloadArgv script needs — the sandbox is
 * fully hermetic, so even bare coreutils must be declared tools. Bare `sh`
 * only auto-resolves on unix, so it is declared on windows only (same
 * convention as the toolchain coreToolNames lists).
 *
 * @param {{ os: string }} plat
 * @returns {string[]}
 */
export function lockedDownloadTools(plat) {
	const tools = ["curl", "mkdir", "dirname", "wc", shaToolName(plat)];
	if (plat.os === "windows") {
		tools.push("sh");
	}
	return tools;
}

/**
 * Download a toolchain artifact, verified against its lockfile by default —
 * the shared cold-path download step every toolchain's acquire composes with
 * its own extract/install runs. Resolves the lockfile entry (throwing, or
 * warning when `unverified`, on any miss), runs the verified download, and
 * decorates a failed transfer or size/SHA-256 mismatch with a
 * `gen-lockfiles` pointer.
 *
 * @param {object} opts
 * @param {string} opts.lockfile Lockfile address, e.g. "//rules/c/mold/mold.lock".
 * @param {string} opts.tool Lockfile `tool` stem, e.g. "mold".
 * @param {string} opts.version
 * @param {{ os: string, arch: string }} opts.plat Host platform (drives the
 *   download script's tool selection).
 * @param {{ os: string, arch: string }} [opts.lockPlat] Platform key used
 *   for the lockfile entry lookup when it differs from the host — e.g.
 *   pex's platform-independent `{ os: "any", arch: "any" }` artifact.
 * @param {string} opts.url Fallback download URL when no lock entry resolves.
 * @param {string} opts.downloadPath Sandbox-relative destination path.
 * @param {object[]} opts.tools Resolved native-tool specs covering
 *   lockedDownloadTools(plat).
 * @param {string} opts.display run() display label.
 * @param {boolean} [opts.unverified=false] Downgrade lockfile misses to a
 *   warning and download unverified.
 * @returns {Promise<string>} The materialized download path.
 */
async function downloadToolArtifactLegacy({
	lockfile,
	tool,
	version,
	plat,
	lockPlat,
	url,
	downloadPath,
	tools,
	display,
	unverified = false,
}) {
	const lockEntry = resolveToolLockfile({
		address: lockfile,
		tool,
		version,
		plat: lockPlat ?? plat,
		unverified,
	});
	const resolvedUrl = lockEntry ? lockEntry.url : url;
	const argv = lockedDownloadArgv({
		plat,
		lockEntry,
		url: resolvedUrl,
		downloadPath,
		displayName: `download-${tool}`,
	});
	try {
		await run({
			argv,
			tools,
			outputs: [output(output_path(downloadPath))],
			materialize: true,
			display,
		});
	} catch (e) {
		if (lockEntry) {
			throw new Error(
				`download of ${tool} ${version} from ${resolvedUrl} failed transfer or ` +
					`size/sha256 verification (expected ${lockEntry.sha256} from ${lockfile}); ` +
					`if you intentionally changed versions, run \`imp goal gen-lockfiles\`: ` +
					`${e && e.message ? e.message : e}`,
			);
		}
		throw e;
	}
	return downloadPath;
}

async function runGraphDownload(exec, inputs) {
	const lockEntry = resolveToolLockfileContents({
		contents: inputs.lockfileContents,
		address: inputs.lockfile,
		tool: inputs.tool,
		version: inputs.version,
		plat: inputs.lockPlat ?? inputs.plat,
		unverified: inputs.unverified,
	});
	const resolvedUrl = lockEntry ? lockEntry.url : inputs.url;
	const argv = lockedDownloadArgv({
		plat: inputs.plat,
		lockEntry,
		url: resolvedUrl,
		downloadPath: inputs.output,
		displayName: `download-${inputs.tool}`,
	});
	const tools = inputs.toolNames.map((_, index) => inputs[`tool${index}`]);
	argv[0] = exec.tool(tools[0], "sh");
	try {
		const result = await exec.action({
			argv,
			tools,
			outputs: { artifact: output.file(inputs.output) },
			display: inputs.display,
		});
		return { artifact: result.outputs.artifact };
	} catch (error) {
		if (lockEntry) {
			throw new Error(
				`download of ${inputs.tool} ${inputs.version} from ${resolvedUrl} failed transfer or ` +
					`size/sha256 verification (expected ${lockEntry.sha256} from ${inputs.lockfile}); ` +
					`if you intentionally changed versions, run \`imp goal gen-lockfiles\`: ` +
					`${error && error.message ? error.message : error}`,
			);
		}
		throw error;
	}
}

function graphDownloadToolArtifact({
	lockfile,
	tool: toolName,
	version,
	plat,
	lockPlat,
	url,
	output: outputPath,
	display = `download ${toolName}`,
	unverified = false,
}) {
	if (typeof outputPath !== "string" || outputPath.length === 0) {
		throw new Error("downloadToolArtifact graph form requires a non-empty output");
	}
	const toolNames = ["sh", ...lockedDownloadTools(plat)];
	const uniqueToolNames = [...new Set(toolNames)];
	const inputs = {
		lockfile,
		lockfileContents: readAddressedFile(lockfile),
		tool: toolName,
		version,
		plat,
		lockPlat: lockPlat ?? null,
		url,
		output: outputPath,
		display,
		unverified,
		toolNames: uniqueToolNames,
	};
	for (const [index, name] of uniqueToolNames.entries()) {
		inputs[`tool${index}`] = nativeTool(name);
	}
	return task({
		inputs,
		outputs: { artifact: output.artifact() },
		run: runGraphDownload,
		display,
	}).outputs.artifact;
}

/**
 * Download a verified tool artifact.
 *
 * The graph form uses `output` and returns an artifact handle immediately.
 * The temporary legacy form uses `downloadPath` and returns a Promise.
 */
export function downloadToolArtifact(opts) {
	if (!opts || typeof opts !== "object") {
		throw new Error("downloadToolArtifact(options) requires an options object");
	}
	if (Object.hasOwn(opts, "output")) {
		if (Object.hasOwn(opts, "downloadPath") || Object.hasOwn(opts, "tools")) {
			throw new Error(
				"downloadToolArtifact graph form cannot include legacy downloadPath or tools",
			);
		}
		return graphDownloadToolArtifact(opts);
	}
	return downloadToolArtifactLegacy(opts);
}

/**
 * argv for a run() downloading a toolchain artifact to `downloadPath` — the
 * blessed way to fetch anything a lockfile pins. With a `lockEntry` (from
 * resolveToolLockfile) the transfer is verified: SHA-256 always, byte size
 * too when the entry records one; any mismatch fails the run (nonzero exit).
 * With `lockEntry: null` (unverified toolchain) it is a plain download of
 * `url`.
 *
 * @param {object} opts
 * @param {{ os: string }} opts.plat
 * @param {{ url: string, size?: number, sha256: string }|null} opts.lockEntry
 * @param {string} opts.url Download URL (lockEntry.url or the caller's fallback).
 * @param {string} opts.downloadPath Destination path.
 * @param {string} opts.displayName argv[0] label for the script, e.g. "download-ruff".
 * @returns {string[]}
 */
export function lockedDownloadArgv({
	plat,
	lockEntry,
	url,
	downloadPath,
	displayName,
}) {
	if (!lockEntry) {
		return [
			"sh",
			"-c",
			'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"',
			displayName,
			downloadPath,
			url,
		];
	}
	const check = plat.os === "macos" ? "shasum -a 256 -c -" : "sha256sum -c -";
	const sizeCheck =
		lockEntry.size === undefined
			? ""
			: ' && actual="$(wc -c < "$1")" && { [ "$actual" -eq "$4" ] || { echo "size mismatch for $1: expected $4 bytes, got $actual" >&2; exit 1; }; }';
	const script =
		'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"' +
		sizeCheck +
		` && printf '%s  %s\\n' "$3" "$1" | ${check}`;
	const argv = [
		"sh",
		"-c",
		script,
		displayName,
		downloadPath,
		url,
		lockEntry.sha256,
	];
	if (lockEntry.size !== undefined) {
		argv.push(String(lockEntry.size));
	}
	return argv;
}
