// The "gen-lockfiles" goal and the shared machinery its per-toolchain products
// reuse.
//
// A tool lockfile pins, for every platform a toolchain publishes a release for,
// the download URL, artifact filename, and SHA-256 of that artifact — so an
// acquire on any machine can be checked against known-good bytes rather than
// trusting a version string alone. Acquire paths verify against the lockfile
// via resolveToolLockfile (rules/imp/lockfile.js); toolchains that pass a
// `lockfile` address here write to that address (e.g. a lock checked in next
// to the rule module ships embedded in the binary), the rest keep writing
// `<name>.lock` at the workspace root until they migrate (imp issue #3).
//
// Each toolchain rule module registers its own
// `product("<x>-toolchain", "gen-lockfiles", ...)` by calling
// generateToolLockfile() with its pure URL/artifact helpers and its published
// platform list. The goal carries no callback, so host dispatch runs that
// product for every selected toolchain target. Invoke as
// `imp goal gen-lockfiles //...`.

import { goal, run, output, output_path, download, sha256 } from "imp:core";
import { lockfileAddressToPath } from "//rules/imp/lockfile";

goal("gen-lockfiles");

const defaultHost = { download, sha256, run, output, output_path };

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

/**
 * Download every published artifact for a toolchain and record its integrity
 * hash into `<name>.lock` at the workspace root.
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
    const artifacts = {};
    for (const plat of platforms) {
        const url = downloadUrl(version, plat);
        const artifact = artifactName(version, plat);
        const path = await host.download(url);
        const digest = await host.sha256(path);
        artifacts[`${plat.os}/${plat.arch}`] = { url, artifact, sha256: digest };
    }

    const lock = { tool: name, version, artifacts };
    const path = lockfile ? lockfileAddressToPath(lockfile) : `${name}.lock`;
    await writeJsonFile(host, path, lock);
    return lock;
}
