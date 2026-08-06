import {
	Toolchain,
	platformInfo,
	product,
	tool as graphTool,
	toolName,
} from "imp:core";

import { extractArchive } from "//rules/imp/archive";
import { downloadToolArtifact } from "//rules/imp/lockfile";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

export const CRANE_TOOL = toolName("crane");

const CRANE_LOCKFILE = "//rules/oci/crane.lock";

const TARGET_OS = {
	linux: "Linux",
	macos: "Darwin",
	windows: "Windows",
};

const TARGET_ARCH = {
	x86_64: "x86_64",
	aarch64: "arm64",
};

function platformParts(plat) {
	const os = TARGET_OS[plat.os];
	const arch = TARGET_ARCH[plat.arch];
	if (!os || !arch) {
		throw new Error(
			`unsupported crane toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return { os, arch };
}

export function craneArtifactName(version, plat) {
	const { os, arch } = platformParts(plat);
	return `go-containerregistry_${os}_${arch}.tar.gz`;
}

export function craneDownloadUrl(version, plat) {
	return `https://github.com/google/go-containerregistry/releases/download/v${version}/${craneArtifactName(version, plat)}`;
}

const CRANE_SUPPORTED_PLATFORMS = [
	{ os: "linux", arch: "x86_64" },
	{ os: "linux", arch: "aarch64" },
	{ os: "macos", arch: "x86_64" },
	{ os: "macos", arch: "aarch64" },
	{ os: "windows", arch: "x86_64" },
];

export function craneSupportedPlatforms() {
	return CRANE_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

export function craneCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

export class CraneToolchain extends Toolchain {
	static kind = "crane-toolchain";
	static tool = CRANE_TOOL;

	constructor({ version, unverified }, opts) {
		super(
			{
				kind: CraneToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}
}

let graphToolchains = new Map();

export function __resetCraneToolchainStateForTest() {
	CraneToolchain.clearDefault();
	graphToolchains = new Map();
}

/**
 * Declare a Crane version and return the graph-native executable tool.
 * Lockfile/default policy remains owned by this configuration API.
 */
export function craneToolchain(version, opts = {}) {
	new CraneToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	const tool = craneGraphTool(version);
	graphToolchains.set(version, tool);
	return tool;
}

export function resolveCraneToolchainVersion(version) {
	return CraneToolchain.resolveVersion(version);
}

/** Build Crane from a verified archive as an ordinary artifact-producing graph. */
export function craneGraphTool(version) {
	const resolved = CraneToolchain.requireVersion(version);
	const plat = platformInfo();
	const archive = downloadToolArtifact({
		lockfile: CRANE_LOCKFILE,
		tool: "crane",
		version: resolved,
		plat,
		url: craneDownloadUrl(resolved, plat),
		output: `crane-downloads/${craneCacheKey(resolved, plat)}/${craneArtifactName(resolved, plat)}`,
		display: `download crane ${resolved} (${plat.os}/${plat.arch})`,
		unverified: CraneToolchain.resolveUnverified(resolved),
	});
	const directory = extractArchive({
		archive,
		dest: "crane-toolchain",
		format: "tar.gz",
		display: `install crane ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

export function defaultCraneToolchainVersion() {
	return CraneToolchain.defaultVersion();
}

export function defaultCraneToolchain() {
	const version = CraneToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

craneToolchain("0.20.6", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "crane",
		platforms: craneSupportedPlatforms(),
		downloadUrl: craneDownloadUrl,
		artifactName: craneArtifactName,
		lockfile: CRANE_LOCKFILE,
	},
	["0.20.6"],
);
product(
	CraneToolchain,
	GEN_LOCKFILES,
	CRANE_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
