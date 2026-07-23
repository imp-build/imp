import {
	Target,
	artifact,
	cacheGet,
	cacheHas,
	glob,
	mergeDigests,
	output,
	output_path,
	paths,
	product,
	productFor,
	run,
	sourcesField,
	targetAddress,
	targetOutputSlug,
	BUILD,
	PACKAGE,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

import { craneTool } from "//rules/oci/toolchain";
import {
	craneAuthTools,
	declareOciStorage,
	OCI_STORAGE_CACHE,
	ociStorageKey,
} from "//rules/oci/storage";
import { CRANE_TOOL } from "//rules/oci/toolchain";

export {
	craneBin,
	craneToolchain,
	defaultCraneToolchain,
	defaultCraneToolchainVersion,
	installCraneToolchain,
	resolveCraneToolchainVersion,
} from "//rules/oci/toolchain";

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/rust/index.js, rules/c/cmake/index.js)
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`OCI paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return targetAddress(handle);
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = safe_target_address(handle);
	if (!address || !address.startsWith("//")) return ".";
	const scope = address.slice(2).split(":")[0];
	return scope.length === 0 ? "." : scope;
}

function declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

// Every other rule module's default output path is now keyed the same way
// (see targetOutputSlug in imp:core) — kept as a local alias since this
// file's own scratch-output paths (oci-build/oci-package) were already using
// this scheme before the others caught up.
const target_output_slug = targetOutputSlug;

// Best-effort registry host extraction from a "repo" or "repo:tag" string,
// for threading into craneAuthTools(). Mirrors crane's own default-registry
// convention: a bare/first path segment without a dot, colon, or "localhost"
// is assumed to be a Docker Hub ("index.docker.io") image name.
function registryHost(repo) {
	const first = repo.split("/")[0];
	if (first.includes(".") || first.includes(":") || first === "localhost") {
		return first;
	}
	return "index.docker.io";
}

// ---------------------------------------------------------------------------
// oci-pull: fetch an image (by tag or digest) into the shared OCI storage
// named cache, as an OCI-layout directory.
// ---------------------------------------------------------------------------

export class OciPull extends Target {
	static kind = "oci-pull";
	constructor({ repo, tag, digest }) {
		if (!repo) {
			throw new Error("ociPull requires 'repo'");
		}
		if (!tag === !digest) {
			throw new Error("ociPull requires exactly one of 'tag' or 'digest'");
		}
		super({
			kind: OciPull.kind,
			attrs: { repo, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) },
		});
	}
}

/**
 * Declare an OCI image pull target: fetches `repo:tag` (or `repo@digest`)
 * into the shared `oci-storage` named cache as an OCI-layout directory, for
 * use as an `ociBuild()` base or an `ociPush()` source.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.repo Image repository, e.g. "docker.io/library/alpine" or "ghcr.io/org/image".
 * @param {string} [opts.tag] Mutable tag — resolved to a digest at build time via `crane digest`.
 * @param {string} [opts.digest] Immutable `sha256:...` digest — skips the resolve step entirely.
 * @returns {object} Target handle.
 */
export function ociPull({ repo, tag, digest }) {
	return new OciPull({ repo, tag, digest });
}

/**
 * Resolve/pull an ociPull() target: an immutable digest, resolved once
 * (impurely — a tag can move) if only a tag was given, then a cached fetch
 * of that digest's OCI-layout directory into `oci-storage`.
 *
 * @param {object} handle Target handle returned by ociPull().
 * @returns {Promise<{ ociLayoutPath: string, digest: string }>}
 */
export const ociPullBuild = product(
	OciPull,
	BUILD,
	CRANE_TOOL,
	async function ociPullBuild(handle) {
		declareOciStorage();
		const craneToolSpec = await craneTool();
		const registry = registryHost(handle.attrs.repo);
		const { tools: authTools, env: authEnv } = await craneAuthTools(registry);

		let digest = handle.attrs.digest;
		if (!digest) {
			const tagRef = `${handle.attrs.repo}:${handle.attrs.tag}`;
			// Always impure: a tag is mutable and may point at different content
			// between builds. Cheap — no image bytes transferred, just a manifest
			// HEAD/GET — so paying this round-trip unconditionally is acceptable.
			const result = await run({
				argv: ["crane", "digest", tagRef],
				tools: [craneToolSpec, ...authTools],
				env: authEnv,
				impure: true,
				display: `resolve ${tagRef}`,
			});
			digest = result.stdout.trim();
		}

		const key = ociStorageKey(digest);
		if (cacheHas(OCI_STORAGE_CACHE, key)) {
			return { ociLayoutPath: cacheGet(OCI_STORAGE_CACHE, key), digest };
		}

		// Pull by the now-immutable digest — genuinely content-addressed, no
		// impure flag needed; a re-run with the same digest replays from cache.
		const digestRef = `${handle.attrs.repo}@${digest}`;
		const dir = `.imp/oci-storage/${key}`;
		await run({
			argv: ["crane", "pull", "--format=oci", digestRef, output_path(dir)],
			tools: [craneToolSpec, ...authTools],
			env: authEnv,
			outputs: [
				output(output_path(dir), {
					kind: "directory",
					namedCache: { name: OCI_STORAGE_CACHE, key },
				}),
			],
			materialize: true,
			display: `pull ${digestRef}`,
		});

		return { ociLayoutPath: cacheGet(OCI_STORAGE_CACHE, key), digest };
	},
	{ display: "build {0}", level: "info" },
);

// An OCI-layout directory referenced by another rule may live outside the
// workspace (an ociPull()'s oci-storage named-cache entry — an absolute
// path) or come from this same invocation's own build graph (an
// ociBuild()'s materialize:false run() output — workspace-relative). The
// former needs the `.imp/tools/<name>` named-cache-mount idiom already
// used throughout rules/ (craneTool(), RUSTUP_HOME, etc.) — a `tools:` entry
// keyed by cache+manifestDigest, symlinked into the sandbox at a fixed,
// deterministic path a script can address directly. The latter is mounted
// via its CAS tree digest (treeDigest) rather than a physical
// {kind:"directory"} input, since it's never actually materialized on disk.
function mountOciLayout(name, layoutPath, manifestDigest, treeDigest) {
	if (layoutPath.startsWith("/")) {
		const key = ociStorageKey(manifestDigest);
		return {
			tools: [
				{ kind: "tool", name, cache: OCI_STORAGE_CACHE, key, binDirs: ["."] },
			],
			inputs: [],
			mountedPath: `.imp/tools/${name}`,
		};
	}
	return {
		tools: [],
		inputs: [{ kind: "digest", digest: treeDigest }],
		mountedPath: layoutPath,
	};
}

// Tar an existing OCI-layout directory (produced by ociPullBuild/
// ociBuildBuild) into a self-contained "oci-archive": the format skopeo and
// podman document for `podman load`, a tar of an OCI Image Layout directory
// rooted at the tar's top level. crane's CLI has no local-layout→tarball
// conversion command of its own (crane push requires a registry
// destination; crane pull's --format=oci→tarball path only applies when
// pulling from a registry), so plain deterministic tar is the correct, and
// only, tool here.
async function packageOciLayoutAsTar(
	handle,
	layoutPath,
	manifestDigest,
	treeDigest,
) {
	const slug = target_output_slug(handle);
	const dir = `.imp/oci-package/${slug}`;
	const mount = mountOciLayout(
		"oci-layout",
		layoutPath,
		manifestDigest,
		treeDigest,
	);

	const tools = [
		await nativeToolSpec(nativeTool("mkdir")),
		await nativeToolSpec(nativeTool("tar")),
		...mount.tools,
	];

	const script =
		'out=$1; layout=$2; mkdir -p "$out" && ' +
		'tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner -C "$layout" -cf "$out/image.tar" .';

	const result = await run({
		argv: [
			"sh",
			"-c",
			script,
			"oci-package-tar",
			output_path(dir),
			mount.mountedPath,
		],
		tools,
		inputs: mount.inputs,
		outputs: [output(output_path(dir), { kind: "directory" })],
		materialize: false,
		display: `package ${slug} as OCI archive tar`,
	});

	return artifact(result.outputDigest, { from: dir });
}

/**
 * Package an ociPull() target: writes the pulled image's OCI-layout
 * directory out as a `dist/.../image.tar` oci-archive tarball, loadable via
 * `podman load` / `docker load`.
 *
 * @param {object} handle Target handle returned by ociPull().
 * @returns {Promise<object>} An artifact(...) whose published dist/ path
 *   will contain an `image.tar`.
 */
export const ociPullPackage = product(
	OciPull,
	PACKAGE,
	CRANE_TOOL,
	async function ociPullPackage(handle) {
		const { ociLayoutPath, digest } = await ociPullBuild(handle);
		return packageOciLayoutAsTar(handle, ociLayoutPath, digest, null);
	},
	{ display: "package {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// oci-build: compose an image from a base plus deterministic file layers, by
// hand-assembling the OCI layout (see COMPOSE_OCI_IMAGE_SCRIPT below) — no
// Dockerfile, no commands executed inside a container, no crane.
// ---------------------------------------------------------------------------

// One layer's staging + tar step. Deterministic tar flags are load-bearing:
// non-reproducible bytes would break the digest-as-cache-key dedup in
// storage.js (two builds of byte-identical sources must produce the same
// layer digest, or every rebuild looks "new" even when nothing changed).
async function buildLayerTarball(handle, packageRoot, layerSpec, index, tools) {
	if (
		!layerSpec ||
		!Array.isArray(layerSpec.srcs) ||
		layerSpec.srcs.length === 0
	) {
		throw new Error(`ociBuild layer ${index} requires non-empty 'srcs'`);
	}
	if (!layerSpec.path) {
		throw new Error(
			`ociBuild layer ${index} requires 'path' (destination directory inside the image)`,
		);
	}

	const fileSet = glob({
		root: packageRoot,
		include: layerSpec.srcs,
		exclude: layerSpec.exclude || [],
	});
	const files = paths(fileSet);
	if (files.length === 0) {
		throw new Error(
			`ociBuild layer ${index}: no files matched 'srcs' under ${packageRoot}`,
		);
	}

	const rootPrefix = packageRoot === "." ? "" : `${packageRoot}/`;
	const destTrimmed = layerSpec.path.replace(/^\/+|\/+$/g, "");
	const destPrefix = destTrimmed === "" ? "" : `/${destTrimmed}`;
	const uid = String(layerSpec.uid ?? 0);
	const gid = String(layerSpec.gid ?? 0);
	const mode = layerSpec.mode ? String(layerSpec.mode) : "";

	const slug = target_output_slug(handle);
	const stageDir = `.imp/oci-build/${slug}/layer-${index}-stage`;
	const tarPath = `.imp/oci-build/${slug}/layer-${index}.tar`;

	// Stage matched files under $stage$destPrefix/<root-relative-path>, then
	// tar the staging directory as a whole — avoids tar --transform's regex
	// footguns (path components containing regex metacharacters) for the
	// sake of a plain mkdir+cp loop.
	const script =
		"stage=$1; tarPath=$2; destPrefix=$3; rootPrefix=$4; mode=$5; uid=$6; gid=$7; shift 7; " +
		'mkdir -p "$stage$destPrefix"; ' +
		'for f in "$@"; do ' +
		'rel="${f#$rootPrefix}"; ' +
		'target="$stage$destPrefix/$rel"; ' +
		'mkdir -p "$(dirname "$target")"; ' +
		'cp "$f" "$target"; ' +
		'if [ -n "$mode" ]; then chmod "$mode" "$target"; fi; ' +
		"done; " +
		'tar --sort=name --mtime="@0" --owner="$uid" --group="$gid" --numeric-owner -C "$stage" -cf "$tarPath" .';

	const result = await run({
		argv: [
			"sh",
			"-c",
			script,
			"oci-layer-tar",
			stageDir,
			tarPath,
			destPrefix,
			rootPrefix,
			mode,
			uid,
			gid,
			...files,
		],
		tools,
		inputs: [fileSet],
		outputs: [output(output_path(tarPath))],
		materialize: false,
		display: `stage OCI layer ${index} (${layerSpec.path})`,
	});

	return { tarPath, digest: result.outputDigest };
}

export class OciBuild extends Target {
	static kind = "oci-build";
	// `base`: an ociPull()/ociBuild() target handle, or the literal string
	// "scratch" for a from-empty image.
	//
	// `layers`: [{ srcs: string[], path: string, exclude?: string[], uid?: number, gid?: number, mode?: string }].
	//
	// Deliberately no `platforms`/multi-arch surface yet — single-manifest
	// only for this pass. When multi-arch support is added, it attaches here
	// (an OCI index assembled via `crane index append` over one build per
	// platform) without needing to change `layers`'/`base`'s shape.
	constructor({
		path = ".",
		base,
		layers = [],
		entrypoint,
		cmd,
		env = {},
		labels = {},
		user,
		workdir,
	}) {
		if (base !== "scratch" && !(base && base.__imp === true)) {
			throw new Error(
				"ociBuild's 'base' must be an ociPull()/ociBuild() target handle, or the string \"scratch\"",
			);
		}
		if (!Array.isArray(layers) || layers.length === 0) {
			throw new Error("ociBuild requires one or more 'layers'");
		}
		const baseHandle = base === "scratch" ? null : base;
		super({
			kind: OciBuild.kind,
			attrs: {
				path,
				base: baseHandle,
				baseIsScratch: base === "scratch",
				layers,
				...(entrypoint ? { entrypoint } : {}),
				...(cmd ? { cmd } : {}),
				...(Object.keys(env).length ? { env } : {}),
				...(Object.keys(labels).length ? { labels } : {}),
				...(user ? { user } : {}),
				...(workdir ? { workdir } : {}),
			},
			sources: layers
				.filter(
					(layer) =>
						layer && Array.isArray(layer.srcs) && layer.srcs.length > 0,
				)
				.map((layer) =>
					sourcesField({
						root: path,
						include: layer.srcs,
						exclude: layer.exclude || [],
					}),
				),
			deps: baseHandle ? [{ target: baseHandle }] : [],
		});
	}
}

/**
 * Declare an OCI image build target: composes `base` plus `layers` into a
 * new image by hand-assembling its OCI layout (layer blobs, config blob,
 * manifest blob, index.json) — no Dockerfile, no commands executed inside a
 * container.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."] Directory (relative to the declaring BUILD.js) `layers[].srcs` glob against.
 * @param {object|"scratch"} opts.base An ociPull()/ociBuild() handle, or "scratch" for an empty base.
 * @param {Array<{srcs: string[], path: string, exclude?: string[], uid?: number, gid?: number, mode?: string}>} opts.layers
 *   One or more file-staging specs; each becomes one deterministic layer tarball.
 * @param {string[]} [opts.entrypoint] Image ENTRYPOINT.
 * @param {string[]} [opts.cmd] Image CMD.
 * @param {Record<string,string>} [opts.env] Image environment variables.
 * @param {Record<string,string>} [opts.labels] Image labels.
 * @param {string} [opts.user] Image USER.
 * @param {string} [opts.workdir] Image WORKDIR.
 * @returns {object} Target handle.
 */
export function ociBuild({
	path = ".",
	base,
	layers = [],
	entrypoint,
	cmd,
	env = {},
	labels = {},
	user,
	workdir,
}) {
	return new OciBuild({
		path,
		base,
		layers,
		entrypoint,
		cmd,
		env,
		labels,
		user,
		workdir,
	});
}

// Assembles an OCI-layout directory by hand: no crane. `crane append --base`
// and `crane mutate` were confirmed (empirically, against the pinned 0.20.6
// binary) to always resolve their image argument as a registry reference —
// neither has any local-tarball/local-directory mode — so composing a local
// image from a local base is fundamentally impossible through crane's CLI.
// An OCI layout is just four kinds of file, all sha256-content-addressed
// under blobs/sha256/<hex>: oci-layout (static), layer blobs (the tars
// already built by buildLayerTarball), a config blob (JSON: platform,
// entrypoint/cmd/env/labels/user/workdir, rootfs.diff_ids, history), and a
// manifest blob (JSON: pointers to config + layers) referenced by
// index.json. Every piece jq/sha256sum/tar can produce directly, and
// deterministically (fixed key order via `jq -S`, no wall-clock timestamps).
//
// Layers are stored uncompressed (mediaType ".tar", not ".tar+gzip") so a
// layer's blob digest and its rootfs diffID are the same sha256sum call —
// gzip would need its own reproducibility fighting (embedded mtime/OS byte)
// for no benefit here, since these are locally-composed layers, not
// registry-transferred ones where bandwidth matters.
const COMPOSE_OCI_IMAGE_SCRIPT = [
	"out=$1; base=$2; os=$3; arch=$4; entrypoint=$5; cmd=$6; envList=$7; labels=$8; user=$9; workdir=${10}",
	"shift 10",
	'mkdir -p "$out/blobs/sha256"',
	'if [ -n "$base" ]; then',
	'    cp -r "$base/." "$out/"',
	'    manifest_digest=$(jq -r ".manifests[0].digest" "$out/index.json" | cut -d: -f2)',
	'    manifest_path="$out/blobs/sha256/$manifest_digest"',
	'    config_digest=$(jq -r ".config.digest" "$manifest_path" | cut -d: -f2)',
	'    config_json=$(cat "$out/blobs/sha256/$config_digest")',
	'    layers_json=$(jq -c ".layers" "$manifest_path")',
	"else",
	'    echo \'{"imageLayoutVersion":"1.0.0"}\' > "$out/oci-layout"',
	'    config_json=$(jq -n -c --arg os "$os" --arg arch "$arch" \'{architecture:$arch,os:$os,config:{},rootfs:{type:"layers",diff_ids:[]},history:[]}\')',
	"    layers_json='[]'",
	"fi",
	'for tarball in "$@"; do',
	'    digest=$(sha256sum "$tarball" | cut -d" " -f1)',
	'    size=$(wc -c < "$tarball")',
	'    cp "$tarball" "$out/blobs/sha256/$digest"',
	'    config_json=$(printf "%s" "$config_json" | jq -c --arg d "sha256:$digest" \'',
	"        .rootfs.diff_ids += [$d]",
	'        | .history += [{"created":"1970-01-01T00:00:00Z","created_by":"imp oci-build"}]',
	"    ')",
	'    layers_json=$(printf "%s" "$layers_json" | jq -c --arg d "sha256:$digest" --argjson size "$size" \'',
	'        . + [{"mediaType":"application/vnd.oci.image.layer.v1.tar","digest":$d,"size":$size}]',
	"    ')",
	"done",
	'config_json=$(printf "%s" "$config_json" | jq -c \\',
	'    --argjson entrypoint "$entrypoint" --argjson cmd "$cmd" --argjson envList "$envList" \\',
	'    --argjson labels "$labels" --arg user "$user" --arg workdir "$workdir" \'',
	"    (if ($entrypoint | length) > 0 then .config.Entrypoint = $entrypoint else . end)",
	"    | (if (\$cmd | length) > 0 then .config.Cmd = \$cmd else . end)",
	"    | (if (\$envList | length) > 0 then",
	'        .config.Env = ((((.config.Env // []) | map(split("=")) | map({(.[0]): (.[1:] | join("="))}) | add // {})',
	'            * ($envList | map(split("=")) | map({(.[0]): (.[1:] | join("="))}) | add))',
	'            | to_entries | map("\\(.key)=\\(.value)"))',
	"      else . end)",
	"    | (if (\$labels | length) > 0 then .config.Labels = ((.config.Labels // {}) * \$labels) else . end)",
	'    | (if $user != "" then .config.User = $user else . end)',
	'    | (if $workdir != "" then .config.WorkingDir = $workdir else . end)',
	"')",
	'config_json=$(printf "%s" "$config_json" | jq -S -c .)',
	'config_digest=$(printf "%s" "$config_json" | sha256sum | cut -d" " -f1)',
	'printf "%s" "$config_json" > "$out/blobs/sha256/$config_digest"',
	'config_size=$(printf "%s" "$config_json" | wc -c)',
	'manifest_json=$(jq -n -c --arg cd "sha256:$config_digest" --argjson cs "$config_size" --argjson layers "$layers_json" \'',
	'    {schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",',
	'     config:{mediaType:"application/vnd.oci.image.config.v1+json",digest:$cd,size:$cs},layers:$layers}',
	"' | jq -S -c .)",
	'manifest_digest=$(printf "%s" "$manifest_json" | sha256sum | cut -d" " -f1)',
	'printf "%s" "$manifest_json" > "$out/blobs/sha256/$manifest_digest"',
	'manifest_size=$(printf "%s" "$manifest_json" | wc -c)',
	'index_json=$(jq -n -c --arg md "sha256:$manifest_digest" --argjson ms "$manifest_size" --arg os "$os" --arg arch "$arch" \'',
	'    {schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",',
	'     manifests:[{mediaType:"application/vnd.oci.image.manifest.v1+json",digest:$md,size:$ms,platform:{architecture:$arch,os:$os}}]}',
	"' | jq -S -c .)",
	'printf "%s" "$index_json" > "$out/index.json"',
	'printf "sha256:%s" "$manifest_digest"',
].join("\n");

export const ociBuildBuild = product(
	OciBuild,
	BUILD,
	CRANE_TOOL,
	async function ociBuildBuild(handle) {
		declareOciStorage();
		const stageTools = [
			await nativeToolSpec(nativeTool("mkdir")),
			await nativeToolSpec(nativeTool("dirname")),
			await nativeToolSpec(nativeTool("cp")),
			await nativeToolSpec(nativeTool("tar")),
		];

		let baseLayoutPath = null;
		let baseManifestDigest = null;
		let baseTreeDigest = null;
		if (!handle.attrs.baseIsScratch) {
			const baseResult = await productFor(handle.attrs.base, BUILD);
			baseLayoutPath = baseResult.ociLayoutPath;
			baseManifestDigest = baseResult.digest;
			baseTreeDigest = baseResult.outputDigest;
		}

		const packageRoot = declared_path(handle, handle.attrs.path || ".");
		const layerTarballs = [];
		for (let i = 0; i < handle.attrs.layers.length; i++) {
			layerTarballs.push(
				await buildLayerTarball(
					handle,
					packageRoot,
					handle.attrs.layers[i],
					i,
					stageTools,
				),
			);
		}
		const layerDigests = layerTarballs
			.map((l) => l.digest)
			.filter((d) => d != null);
		const layerTreeDigest =
			layerDigests.length > 0 ? mergeDigests(layerDigests) : null;

		const slug = target_output_slug(handle);
		const builtDir = `.imp/oci-build/${slug}/image`;

		const mount = baseLayoutPath
			? mountOciLayout(
					"oci-base",
					baseLayoutPath,
					baseManifestDigest,
					baseTreeDigest,
				)
			: { tools: [], inputs: [], mountedPath: "" };

		// No explicit platform option yet (ociBuild() has none) — hardcoded to
		// linux/amd64 for this first pass, same slot the multi-arch comment on
		// OciBuild's constructor already earmarks for a future `platforms` list.
		const os = "linux";
		const arch = "amd64";
		const envList = Object.entries(handle.attrs.env || {}).map(
			([k, v]) => `${k}=${v}`,
		);

		const composeArgs = [
			"sh",
			"-c",
			COMPOSE_OCI_IMAGE_SCRIPT,
			"oci-compose",
			output_path(builtDir),
			mount.mountedPath,
			os,
			arch,
			JSON.stringify(handle.attrs.entrypoint || []),
			JSON.stringify(handle.attrs.cmd || []),
			JSON.stringify(envList),
			JSON.stringify(handle.attrs.labels || {}),
			handle.attrs.user || "",
			handle.attrs.workdir || "",
			...layerTarballs.map((l) => l.tarPath),
		];

		const result = await run({
			argv: composeArgs,
			tools: [
				await nativeToolSpec(nativeTool("jq")),
				await nativeToolSpec(nativeTool("sha256sum")),
				await nativeToolSpec(nativeTool("cp")),
				await nativeToolSpec(nativeTool("mkdir")),
				...mount.tools,
			],
			inputs: [
				...(layerTreeDigest
					? [{ kind: "digest", digest: layerTreeDigest }]
					: []),
				...mount.inputs,
			],
			outputs: [output(output_path(builtDir), { kind: "directory" })],
			materialize: false,
			display: `compose ${slug}`,
		});

		const digest = result.stdout.trim();
		return {
			ociLayoutPath: builtDir,
			digest,
			outputDigest: result.outputDigest,
		};
	},
	{ display: "build {0}", level: "info" },
);

/**
 * Package an ociBuild() target: writes the composed image's OCI-layout
 * directory out as a `dist/.../image.tar` oci-archive tarball, loadable via
 * `podman load` / `docker load`.
 *
 * @param {object} handle Target handle returned by ociBuild().
 * @returns {Promise<object>} An artifact(...) whose published dist/ path
 *   will contain an `image.tar`.
 */
export const ociBuildPackage = product(
	OciBuild,
	PACKAGE,
	CRANE_TOOL,
	async function ociBuildPackage(handle) {
		const { ociLayoutPath, digest, outputDigest } = await ociBuildBuild(handle);
		return packageOciLayoutAsTar(handle, ociLayoutPath, digest, outputDigest);
	},
	{ display: "package {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// oci-push: publish an ociPull()/ociBuild() image to a registry.
// ---------------------------------------------------------------------------

export class OciPush extends Target {
	static kind = "oci-push";
	constructor({ image, repo, tag }) {
		if (!image || image.__imp !== true) {
			throw new Error(
				"ociPush requires 'image' (an ociPull()/ociBuild() target handle)",
			);
		}
		if (!repo) {
			throw new Error("ociPush requires 'repo'");
		}
		if (!tag) {
			throw new Error("ociPush requires 'tag'");
		}
		super({
			kind: OciPush.kind,
			attrs: { image, repo, tag },
			deps: [{ target: image }],
		});
	}
}

/**
 * Declare an OCI image push target: publishes an ociPull()/ociBuild() image
 * to `repo:tag`.
 *
 * @category target
 * @param {object} opts
 * @param {object} opts.image An ociPull()/ociBuild() target handle.
 * @param {string} opts.repo Destination repository.
 * @param {string} opts.tag Destination tag.
 * @returns {object} Target handle.
 */
export function ociPush({ image, repo, tag }) {
	return new OciPush({ image, repo, tag });
}

export const ociPushBuild = product(
	OciPush,
	BUILD,
	CRANE_TOOL,
	async function ociPushBuild(handle) {
		const { ociLayoutPath, digest, outputDigest } = await productFor(
			handle.attrs.image,
			BUILD,
		);
		const craneToolSpec = await craneTool();
		const registry = registryHost(handle.attrs.repo);
		const { tools: authTools, env: authEnv } = await craneAuthTools(registry);
		const ref = `${handle.attrs.repo}:${handle.attrs.tag}`;
		// Same "layout may live outside or inside the workspace" split as
		// packageOciLayoutAsTar — an oci-build image is never materialized, so
		// it's mounted via its CAS tree digest rather than a physical directory.
		const mount = mountOciLayout(
			"oci-push-image",
			ociLayoutPath,
			digest,
			outputDigest,
		);

		// Network side effect — must always re-run, never replay from the task
		// cache.
		return run({
			argv: ["crane", "push", mount.mountedPath, ref],
			tools: [craneToolSpec, ...authTools, ...mount.tools],
			env: authEnv,
			inputs: mount.inputs,
			impure: true,
			display: `push ${ref}`,
		});
	},
	{ display: "build {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// oci-mirror: re-host an image between two registries via `crane copy`, with
// no local materialization — a convenience composition of the primitives
// above, not built from ociPull()+ociPush().
// ---------------------------------------------------------------------------

export class OciMirror extends Target {
	static kind = "oci-mirror";
	constructor({ from, to }) {
		if (!from || !from.repo || !(from.tag || from.digest)) {
			throw new Error("ociMirror requires 'from: { repo, tag|digest }'");
		}
		if (!to || !to.repo || !to.tag) {
			throw new Error("ociMirror requires 'to: { repo, tag }'");
		}
		super({ kind: OciMirror.kind, attrs: { from, to } });
	}
}

/**
 * Declare an OCI mirror target: re-hosts an image from one registry ref to
 * another via `crane copy` (registry-to-registry, no local disk
 * materialization) — e.g. mirroring a public upstream image into an internal
 * registry without a Dockerfile.
 *
 * @category target
 * @param {object} opts
 * @param {object} opts.from Source ref: `{ repo, tag }` or `{ repo, digest }`.
 * @param {object} opts.to Destination ref: `{ repo, tag }`.
 * @returns {object} Target handle.
 */
export function ociMirror({ from, to }) {
	return new OciMirror({ from, to });
}

export const ociMirrorBuild = product(
	OciMirror,
	BUILD,
	CRANE_TOOL,
	async function ociMirrorBuild(handle) {
		const craneToolSpec = await craneTool();
		const { from, to } = handle.attrs;
		const srcRef = from.digest
			? `${from.repo}@${from.digest}`
			: `${from.repo}:${from.tag}`;
		const dstRef = `${to.repo}:${to.tag}`;

		const srcAuth = await craneAuthTools(registryHost(from.repo));
		const dstAuth = await craneAuthTools(registryHost(to.repo));

		return run({
			argv: ["crane", "copy", srcRef, dstRef],
			tools: [craneToolSpec, ...srcAuth.tools, ...dstAuth.tools],
			env: [...srcAuth.env, ...dstAuth.env],
			impure: true,
			display: `mirror ${srcRef} -> ${dstRef}`,
		});
	},
	{ display: "build {0}", level: "info" },
);
