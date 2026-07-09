import { namedCache } from "imp:core";

// The named cache backing every OCI-layout directory this module produces or
// pulls: base images fetched by ociPull(), and images assembled by
// ociBuild(). Keyed directly by content digest (see ociStorageKey below)
// rather than a synthetic version/platform pair like the toolchain caches —
// OCI content is already content-addressed by the registry, so re-deriving a
// synthetic key would just be redundant indirection with a real risk of
// staleness if a tag moves. Two rules pulling/building the identical digest
// land in the same cache entry and skip re-pulling/rebuilding for free.
export const OCI_STORAGE_CACHE = "oci-storage";

let declared = false;

/**
 * Declare the shared OCI storage named cache. Idempotent — safe to call from
 * every rule constructor that needs it (namedCache() declarations are
 * themselves idempotent, but this avoids the redundant host round-trip in
 * happy path use).
 *
 * @category configuration
 */
export function declareOciStorage() {
    if (declared) return;
    namedCache({ name: OCI_STORAGE_CACHE });
    declared = true;
}

export function __resetOciStorageStateForTest() {
    declared = false;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Turn a canonical image digest into an `oci-storage` cache key.
 *
 * @category configuration
 * @param {string} digest A canonical `sha256:<hex>` digest, e.g. as returned
 *   by `crane digest`.
 * @returns {string} `sha256/<hex>` — cachePut/cacheGet treat keys as opaque
 *   path segments, so the colon is swapped for a path-safe separator.
 */
export function ociStorageKey(digest) {
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
        throw new Error(`ociStorageKey: not a canonical digest: ${JSON.stringify(digest)}`);
    }
    return digest.replace(":", "/");
}

// ---------------------------------------------------------------------------
// Auth seam (deferred — see the OCI plan's "Auth seam" section)
// ---------------------------------------------------------------------------

/**
 * Resolve the tools/env a `run()` touching `registry` should use for
 * authentication. Currently a no-op placeholder — no credential-sourcing
 * mechanism has been built yet (deliberately deferred; worth checking how
 * Bazel's rules_oci handles this before committing to a shape). Every
 * registry-touching run() in this module threads its result through, so a
 * real implementation (e.g. a DOCKER_CONFIG-pointed namedCache populated by
 * a future craneLogin()) can slot in here later without touching call sites.
 *
 * @category configuration
 * @param {string} registry Registry host the upcoming run() will talk to.
 * @returns {Promise<{ tools: object[], env: string[] }>}
 */
export async function craneAuthTools(registry) {
    void registry;
    return { tools: [], env: [] };
}
