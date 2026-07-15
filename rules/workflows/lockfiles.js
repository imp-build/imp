// The "gen-lockfiles" goal and the shared machinery its per-toolchain products
// reuse.
//
// A tool lockfile pins, for every locked version and every platform a
// toolchain publishes a release for, the download URL, artifact filename,
// size, and SHA-256 of that artifact — so an acquire on any machine can be
// checked against known-good bytes rather than trusting a version string
// alone. Generation is additive: regenerating after a version bump inserts
// the new version and keeps every previously locked one, so downgrading to
// an already-locked version needs no regeneration. Regenerating an
// already-locked version replaces that version's entries wholly.
//
// Acquire paths verify against the lockfile via resolveToolLockfile
// (rules/imp/lockfile.js); every toolchain here passes a `lockfile` address
// so the lock is checked in next to its rule module and ships embedded in the
// binary. Omitting `lockfile` falls back to `<name>.lock` at the workspace
// root — only useful for one-off/test lock generation, not for toolchains
// meant to ship a pinned lockfile.
//
// Each toolchain rule module registers its own
// `product(SomeToolchain, GEN_LOCKFILES, ...)` by calling
// generateToolLockfile() with its pure URL/artifact helpers and its published
// platform list. The goal carries no callback, so host dispatch runs that
// product for every selected toolchain target. Invoke as
// `imp goal gen-lockfiles //...`.
//
// Separately, each toolchain module calls registerBuiltinLockfile() with the
// version list its *shipped* lockfile should pin. Those checked-in locks are
// derived state: `imp goal gen-builtin-lockfiles`
// (rules/workflows/builtin_lockfiles.js) regenerates every one to exactly
// its registered versions, needing no toolchain targets in any workspace —
// the registered list is the source of truth (bump = append, prune = remove).

import {
    goal,
    run,
    output,
    output_path,
    download,
    sha256,
    file_size,
    readAddressedFile,
} from "imp:core";
import { lockfileAddressToPath } from "//rules/imp/lockfile";

/** Token for the per-toolchain lockfile-generation product; toolchain rule
 * modules register it via `product(SomeToolchain, GEN_LOCKFILES, ...)`. */
export const GEN_LOCKFILES = goal("gen-lockfiles");

const defaultHost = { download, sha256, file_size, readAddressedFile, run, output, output_path };

// Write a JSON file as a cacheable run(). Content rides in a positional
// argument so no shell interpolation touches it (mirrors rules/workflows/vs.js).
function writeJsonFile(host, path, value) {
    return host.run({
        argv: [
            "sh",
            "-c",
            'printf %s "$2" > "$1"',
            "lockfile-write",
            host.output_path(path),
            `${JSON.stringify(value, null, 2)}\n`,
        ],
        outputs: [host.output(path)],
        materialize: true,
        display: `write ${path}`,
    });
}

// Versions already locked at `address` for tool `name`, as a
// version → platform-map object. Missing file, invalid JSON, or a lock for a
// different tool yields {} (start fresh). A legacy single-version lock
// (`{ tool, version, artifacts }`) folds into its one version so regeneration
// upgrades it in place without dropping the pinned entries.
function existingLockedVersions(host, address, name) {
    const contents = host.readAddressedFile(address);
    if (contents === null) {
        return {};
    }
    let existing;
    try {
        existing = JSON.parse(contents);
    } catch {
        return {};
    }
    if (!existing || existing.tool !== name) {
        return {};
    }
    if (existing.versions && typeof existing.versions === "object") {
        return existing.versions;
    }
    if (existing.version && existing.artifacts) {
        return { [existing.version]: existing.artifacts };
    }
    return {};
}

/**
 * Download every published artifact for a toolchain version and record its
 * integrity data into a lockfile, normally at the address given by
 * `opts.lockfile`. Previously locked versions are preserved (additive);
 * re-locking an existing version replaces that version's entries.
 *
 * @param {object} opts
 * @param {object} opts.handle Toolchain target handle (reads `attrs.version`).
 * @param {string} opts.name Tool name, also the lockfile stem, e.g. "odin".
 * @param {Array<{ os: string, arch: string }>} opts.platforms Published platforms.
 * @param {(version: string, plat: object) => string} opts.downloadUrl
 * @param {(version: string, plat: object) => string} opts.artifactName
 * @param {string} [opts.lockfile] Lockfile address (`//a/b.lock`); defaults
 *   to `<name>.lock` at the workspace root.
 * @param {object} [host] Injectable host for tests (download/sha256/run/...).
 * @returns {Promise<object>} The lockfile contents that were written.
 */
export async function generateToolLockfile(
    { handle, name, platforms, downloadUrl, artifactName, lockfile },
    host = defaultHost,
) {
    const version = handle.attrs.version;
    const address = lockfile ?? `//${name}.lock`;
    const versions = existingLockedVersions(host, address, name);
    versions[version] = await lockVersionArtifacts(host, { version, platforms, downloadUrl, artifactName });

    const lock = { tool: name, versions: sortedVersions(versions) };
    const path = lockfile ? lockfileAddressToPath(lockfile) : `${name}.lock`;
    await writeJsonFile(host, path, lock);
    return lock;
}

async function lockVersionArtifacts(host, { version, platforms, downloadUrl, artifactName }) {
    const artifacts = {};
    for (const plat of platforms) {
        const url = downloadUrl(version, plat);
        const artifact = artifactName(version, plat);
        const path = await host.download(url);
        const digest = await host.sha256(path);
        const size = await host.file_size(path);
        artifacts[`${plat.os}/${plat.arch}`] = { url, artifact, size, sha256: digest };
    }
    return artifacts;
}

function sortedVersions(versions) {
    return Object.fromEntries(
        Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
}

const builtinRegistry = [];

/**
 * Register the shipped (checked-in, embedded) lockfile for a toolchain.
 * Called once at module load by each toolchain rule module; consumed by the
 * gen-builtin-lockfiles goal. `versions` is authoritative — regeneration
 * writes exactly these versions, so bumping, downgrading support, and
 * pruning are all edits to this list.
 *
 * @param {object} spec Same shape as generateToolLockfile's opts minus
 *   `handle`, plus `versions: string[]`; `lockfile` is required.
 */
export function registerBuiltinLockfile(spec) {
    if (!spec.lockfile) {
        throw new Error(`builtin lockfile for '${spec.name}' must declare a lockfile address`);
    }
    if (!Array.isArray(spec.versions) || spec.versions.length === 0) {
        throw new Error(`builtin lockfile for '${spec.name}' must declare at least one version`);
    }
    builtinRegistry.push(spec);
}

/** Registered builtin lockfile specs, in registration order. */
export function builtinLockfiles() {
    return [...builtinRegistry];
}

/**
 * Register a toolchain's builtin (checked-in) lockfile and return the spec
 * for the caller's own `product(SomeToolchain, GEN_LOCKFILES, tool, ...)`
 * registration — every toolchain rule module otherwise repeats the
 * `registerBuiltinLockfile({ ...spec, versions })` line verbatim.
 *
 * Deliberately does *not* also register the `gen-lockfiles` product itself:
 * module attribution for capability docs is derived by walking the JS call
 * stack back to the first `//rules/` frame (see `product()`'s docs), so
 * `product()` must still be called directly from each toolchain's own module
 * — routing it through this shared helper would misattribute every
 * toolchain's registration to `//rules/workflows` instead of its own
 * language group.
 *
 * @param {object} spec Same shape as generateToolLockfile's opts minus
 *   `handle`.
 * @param {string[]} versions Versions the shipped lockfile should pin.
 * @returns {object} `spec`, for the caller's own `generateToolLockfile` call.
 */
export function registerToolchainLockfile(spec, versions) {
    registerBuiltinLockfile({ ...spec, versions });
    return spec;
}

/**
 * Regenerate a builtin lockfile to exactly its registered versions — no
 * merge with existing contents; the spec's version list is the source of
 * truth.
 *
 * @param {object} spec A registerBuiltinLockfile() spec.
 * @param {object} [host] Injectable host for tests.
 * @returns {Promise<object>} The lockfile contents that were written.
 */
export async function generateBuiltinLockfile(spec, host = defaultHost) {
    const { name, versions, platforms, downloadUrl, artifactName, lockfile } = spec;
    const locked = {};
    for (const version of versions) {
        locked[version] = await lockVersionArtifacts(host, { version, platforms, downloadUrl, artifactName });
    }
    const lock = { tool: name, versions: sortedVersions(locked) };
    await writeJsonFile(host, lockfileAddressToPath(lockfile), lock);
    return lock;
}
