// Toolchain-lockfile resolution and verified-download script helpers.
//
// A tool lockfile (written by `imp goal gen-lockfiles`, see
// rules/workflows/lockfiles.js) pins per-platform download URL, artifact
// name, and SHA-256 for one toolchain version. Lockfiles are referenced by
// workspace *address* (`//rules/python/ruff-toolchain.lock`), resolved by
// readAddressedFile with the same precedence as module imports: a file under
// the workspace root wins, with imp's built-in rules tree as the fallback
// for `//rules/...` — so a lockfile checked in next to its rule module ships
// embedded in the binary, and a consumer overrides it by placing a file at
// the same address or pointing the toolchain at a different one.
//
// Miss policy: a missing lockfile, wrong tool/version, or absent platform
// entry throws (the actionable default), unless the toolchain was declared
// with `unverified: true`, which downgrades to a warning and an unverified
// download.
import { logWarn, readAddressedFile } from "imp:core";

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
    if (rel.length === 0 || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`lockfile address '${address}' must be a workspace-relative file path`);
    }
    return rel;
}

/**
 * Resolve the lockfile entry pinning a toolchain artifact for a platform.
 *
 * Returns `{ url, artifact, sha256 }` on a match. On any miss (no lockfile
 * at the address, tool/version mismatch, or no entry for the platform):
 * throws with a pointer to gen-lockfiles, or — if `unverified` — warns and
 * returns null so the caller falls back to an unverified download.
 *
 * @param {object} opts
 * @param {string} opts.address Lockfile address, e.g. "//rules/python/ruff-toolchain.lock".
 * @param {string} opts.tool Lockfile `tool` stem, e.g. "ruff-toolchain".
 * @param {string} opts.version
 * @param {{ os: string, arch: string }} opts.plat
 * @param {boolean} [opts.unverified=false]
 * @returns {{ url: string, artifact: string, sha256: string }|null}
 */
export function resolveToolLockfile({ address, tool, version, plat, unverified = false }) {
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

    const contents = readAddressedFile(address);
    if (contents === null) {
        return miss(`no lockfile found at ${address} for ${tool} ${version}`);
    }
    let lock;
    try {
        lock = JSON.parse(contents);
    } catch (e) {
        return miss(`lockfile ${address} is not valid JSON (${e.message})`);
    }
    if (lock.tool !== tool || lock.version !== version) {
        return miss(
            `lockfile ${address} pins ${lock.tool} ${lock.version}, not ${tool} ${version}`,
        );
    }
    const entry = (lock.artifacts || {})[`${plat.os}/${plat.arch}`];
    if (!entry || !entry.sha256 || !entry.url) {
        return miss(`lockfile ${address} has no entry for platform ${plat.os}/${plat.arch}`);
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
 * `sh -c` script downloading `$2` to `$1` and verifying its SHA-256 against
 * `$3` — the verified variant of the plain curl script the toolchain acquire
 * paths use. A digest mismatch fails the run (nonzero exit).
 *
 * @param {{ os: string }} plat
 * @returns {string}
 */
export function shaCheckedDownloadScript(plat) {
    const check = plat.os === "macos" ? "shasum -a 256 -c -" : "sha256sum -c -";
    return `mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2" && printf '%s  %s\\n' "$3" "$1" | ${check}`;
}
