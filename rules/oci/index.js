import {
    Target,
    cacheGet,
    cacheHas,
    glob,
    output,
    output_path,
    paths,
    product,
    productFor,
    run,
    targetAddress,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

import { craneTool } from "//rules/oci/toolchain";
import { craneAuthTools, declareOciStorage, OCI_STORAGE_CACHE, ociStorageKey } from "//rules/oci/storage";

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

// Stable, path-safe slug for a target's own scratch-output directory. Falls
// back to the numeric handle id for anonymous (unaddressed) handles, e.g. in
// tests that build targets without exporting them from a BUILD.js.
function target_output_slug(handle) {
    const address = safe_target_address(handle);
    if (!address) return `anon-${handle.__id}`;
    return address.replace(/^\/\//, "").replace(/[:/]/g, "_");
}

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
export const ociPullBuild = product("oci-pull", "build", async function ociPullBuild(handle) {
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
        outputs: [output(output_path(dir), { kind: "directory", namedCache: { name: OCI_STORAGE_CACHE, key } })],
        materialize: true,
        display: `pull ${digestRef}`,
    });

    return { ociLayoutPath: cacheGet(OCI_STORAGE_CACHE, key), digest };
});

// ---------------------------------------------------------------------------
// oci-build: compose an image from a base plus deterministic file layers,
// purely declaratively (crane append + crane mutate) — no Dockerfile, no
// commands executed inside a container.
// ---------------------------------------------------------------------------

// One layer's staging + tar step. Deterministic tar flags are load-bearing:
// non-reproducible bytes would break the digest-as-cache-key dedup in
// storage.js (two builds of byte-identical sources must produce the same
// layer digest, or every rebuild looks "new" even when nothing changed).
async function buildLayerTarball(handle, packageRoot, layerSpec, index, tools) {
    if (!layerSpec || !Array.isArray(layerSpec.srcs) || layerSpec.srcs.length === 0) {
        throw new Error(`ociBuild layer ${index} requires non-empty 'srcs'`);
    }
    if (!layerSpec.path) {
        throw new Error(`ociBuild layer ${index} requires 'path' (destination directory inside the image)`);
    }

    const fileSet = glob({ root: packageRoot, include: layerSpec.srcs, exclude: layerSpec.exclude || [] });
    const files = paths(fileSet);
    if (files.length === 0) {
        throw new Error(`ociBuild layer ${index}: no files matched 'srcs' under ${packageRoot}`);
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
    const script = 'stage=$1; tarPath=$2; destPrefix=$3; rootPrefix=$4; mode=$5; uid=$6; gid=$7; shift 7; ' +
        'mkdir -p "$stage$destPrefix"; ' +
        'for f in "$@"; do ' +
        'rel="${f#$rootPrefix}"; ' +
        'target="$stage$destPrefix/$rel"; ' +
        'mkdir -p "$(dirname "$target")"; ' +
        'cp "$f" "$target"; ' +
        'if [ -n "$mode" ]; then chmod "$mode" "$target"; fi; ' +
        'done; ' +
        'tar --sort=name --mtime="@0" --owner="$uid" --group="$gid" --numeric-owner -C "$stage" -cf "$tarPath" .';

    await run({
        argv: ["sh", "-c", script, "oci-layer-tar", stageDir, tarPath, destPrefix, rootPrefix, mode, uid, gid, ...files],
        tools,
        inputs: [fileSet],
        outputs: [output(output_path(tarPath))],
        materialize: true,
        display: `stage OCI layer ${index} (${layerSpec.path})`,
    });

    return tarPath;
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
    constructor({ path = ".", base, layers = [], entrypoint, cmd, env = {}, labels = {}, user, workdir }) {
        if (base !== "scratch" && !(base && base.__imp === true)) {
            throw new Error("ociBuild's 'base' must be an ociPull()/ociBuild() target handle, or the string \"scratch\"");
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
            deps: baseHandle ? [{ target: baseHandle }] : [],
        });
    }
}

/**
 * Declare an OCI image build target: composes `base` plus `layers` into a
 * new image purely declaratively (`crane append` for layers, `crane mutate`
 * for config) — no Dockerfile, no commands executed inside a container.
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
export function ociBuild({ path = ".", base, layers = [], entrypoint, cmd, env = {}, labels = {}, user, workdir }) {
    return new OciBuild({ path, base, layers, entrypoint, cmd, env, labels, user, workdir });
}

export const ociBuildBuild = product("oci-build", "build", async function ociBuildBuild(handle) {
    declareOciStorage();
    const craneToolSpec = await craneTool();
    const stageTools = [
        craneToolSpec,
        await nativeToolSpec(nativeTool("mkdir")),
        await nativeToolSpec(nativeTool("dirname")),
        await nativeToolSpec(nativeTool("cp")),
        await nativeToolSpec(nativeTool("tar")),
    ];

    let baseLayoutPath = null;
    if (!handle.attrs.baseIsScratch) {
        const baseResult = await productFor(handle.attrs.base, "build");
        baseLayoutPath = baseResult.ociLayoutPath;
    }

    const packageRoot = declared_path(handle, handle.attrs.path || ".");
    const layerTarballs = [];
    for (let i = 0; i < handle.attrs.layers.length; i++) {
        layerTarballs.push(await buildLayerTarball(handle, packageRoot, handle.attrs.layers[i], i, stageTools));
    }

    const slug = target_output_slug(handle);
    const builtDir = `.imp/oci-build/${slug}/image`;

    const appendArgs = [
        "crane", "append",
        ...(baseLayoutPath ? ["-f", baseLayoutPath] : []),
        ...layerTarballs.flatMap((tar) => ["--new_layer", tar]),
        "--output", output_path(builtDir),
    ];
    await run({
        argv: appendArgs,
        tools: [craneToolSpec],
        inputs: [
            ...layerTarballs.map((tar) => ({ kind: "file", path: tar })),
            ...(baseLayoutPath ? [{ kind: "directory", path: baseLayoutPath }] : []),
        ],
        outputs: [output(output_path(builtDir), { kind: "directory" })],
        materialize: true,
        display: `build ${slug}`,
    });

    const hasConfig = handle.attrs.entrypoint || handle.attrs.cmd
        || (handle.attrs.env && Object.keys(handle.attrs.env).length)
        || (handle.attrs.labels && Object.keys(handle.attrs.labels).length)
        || handle.attrs.user || handle.attrs.workdir;

    if (hasConfig) {
        // NOTE: crane mutate's --entrypoint/--cmd flag value format (comma-
        // joined list vs. repeated flag) needs a one-time live check against
        // the pinned crane version before this is trusted blindly in tests.
        const mutateArgs = [
            "crane", "mutate", output_path(builtDir),
            "--output", output_path(builtDir),
            ...(handle.attrs.entrypoint ? ["--entrypoint", handle.attrs.entrypoint.join(",")] : []),
            ...(handle.attrs.cmd ? ["--cmd", handle.attrs.cmd.join(",")] : []),
            ...Object.entries(handle.attrs.env || {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
            ...Object.entries(handle.attrs.labels || {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
            ...(handle.attrs.user ? ["--user", handle.attrs.user] : []),
            ...(handle.attrs.workdir ? ["--workdir", handle.attrs.workdir] : []),
        ];
        await run({
            argv: mutateArgs,
            tools: [craneToolSpec],
            inputs: [{ kind: "directory", path: builtDir }],
            outputs: [output(output_path(builtDir), { kind: "directory" })],
            materialize: true,
            display: `configure ${slug}`,
        });
    }

    // Local digest resolution — reads the OCI-layout dir directly, no
    // network, safe to treat as ordinary cacheable work.
    const digestResult = await run({
        argv: ["crane", "digest", builtDir],
        tools: [craneToolSpec],
        inputs: [{ kind: "directory", path: builtDir }],
        display: `digest ${slug}`,
    });
    const digest = digestResult.stdout.trim();

    return { ociLayoutPath: builtDir, digest };
});

// ---------------------------------------------------------------------------
// oci-push: publish an ociPull()/ociBuild() image to a registry.
// ---------------------------------------------------------------------------

export class OciPush extends Target {
    static kind = "oci-push";
    constructor({ image, repo, tag }) {
        if (!image || image.__imp !== true) {
            throw new Error("ociPush requires 'image' (an ociPull()/ociBuild() target handle)");
        }
        if (!repo) {
            throw new Error("ociPush requires 'repo'");
        }
        if (!tag) {
            throw new Error("ociPush requires 'tag'");
        }
        super({ kind: OciPush.kind, attrs: { image, repo, tag }, deps: [{ target: image }] });
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

export const ociPushBuild = product("oci-push", "build", async function ociPushBuild(handle) {
    const { ociLayoutPath } = await productFor(handle.attrs.image, "build");
    const craneToolSpec = await craneTool();
    const registry = registryHost(handle.attrs.repo);
    const { tools: authTools, env: authEnv } = await craneAuthTools(registry);
    const ref = `${handle.attrs.repo}:${handle.attrs.tag}`;

    // Network side effect — must always re-run, never replay from the task
    // cache.
    return run({
        argv: ["crane", "push", ociLayoutPath, ref],
        tools: [craneToolSpec, ...authTools],
        env: authEnv,
        inputs: [{ kind: "directory", path: ociLayoutPath }],
        impure: true,
        display: `push ${ref}`,
    });
});

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

export const ociMirrorBuild = product("oci-mirror", "build", async function ociMirrorBuild(handle) {
    const craneToolSpec = await craneTool();
    const { from, to } = handle.attrs;
    const srcRef = from.digest ? `${from.repo}@${from.digest}` : `${from.repo}:${from.tag}`;
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
});
