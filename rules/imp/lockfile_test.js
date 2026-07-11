import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    lockfileAddressToPath,
    resolveToolLockfile,
    shaCheckedDownloadScript,
    shaToolName,
} from "//rules/imp/lockfile";

const ADDRESS = "//rules/python/ruff-toolchain.lock";
const PLAT = { os: "linux", arch: "x86_64" };

function lockJson(overrides = {}) {
    return JSON.stringify({
        tool: "ruff-toolchain",
        version: "0.15.21",
        artifacts: {
            "linux/x86_64": {
                url: "https://example.com/ruff.tar.gz",
                artifact: "ruff.tar.gz",
                sha256: "abc123",
            },
        },
        ...overrides,
    });
}

describe("toolchain lockfiles", () => {

test("converts a lockfile address to a workspace-relative path", () => {
    expect(lockfileAddressToPath(ADDRESS)).toBe("rules/python/ruff-toolchain.lock");
    let message = null;
    try {
        lockfileAddressToPath("//../escape.lock");
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("workspace-relative");
});

test("resolves a matching lockfile entry", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson());
        const entry = resolveToolLockfile({
            address: ADDRESS,
            tool: "ruff-toolchain",
            version: "0.15.21",
            plat: PLAT,
        });
        expect(entry.sha256).toBe("abc123");
        expect(entry.url).toBe("https://example.com/ruff.tar.gz");
    });
});

test("missing lockfile throws with a gen-lockfiles pointer", async () => {
    await withFakeToolchainHost(async () => {
        let message = null;
        try {
            resolveToolLockfile({
                address: ADDRESS,
                tool: "ruff-toolchain",
                version: "0.15.21",
                plat: PLAT,
            });
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no lockfile found");
        expect(message).toContain("gen-lockfiles");
    });
});

test("version mismatch throws", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson({ version: "0.15.20" }));
        let message = null;
        try {
            resolveToolLockfile({
                address: ADDRESS,
                tool: "ruff-toolchain",
                version: "0.15.21",
                plat: PLAT,
            });
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("pins ruff-toolchain 0.15.20");
    });
});

test("missing platform entry throws", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson());
        let message = null;
        try {
            resolveToolLockfile({
                address: ADDRESS,
                tool: "ruff-toolchain",
                version: "0.15.21",
                plat: { os: "macos", arch: "aarch64" },
            });
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no entry for platform macos/aarch64");
    });
});

test("unverified downgrades misses to warn-and-null", async () => {
    await withFakeToolchainHost(async () => {
        const entry = resolveToolLockfile({
            address: ADDRESS,
            tool: "ruff-toolchain",
            version: "0.15.21",
            plat: PLAT,
            unverified: true,
        });
        expect(entry).toBe(null);
    });
});

test("selects the sha tool and check command per platform", () => {
    expect(shaToolName({ os: "linux" })).toBe("sha256sum");
    expect(shaToolName({ os: "windows" })).toBe("sha256sum");
    expect(shaToolName({ os: "macos" })).toBe("shasum");
    expect(shaCheckedDownloadScript({ os: "linux" })).toContain("sha256sum -c -");
    expect(shaCheckedDownloadScript({ os: "macos" })).toContain("shasum -a 256 -c -");
    expect(shaCheckedDownloadScript({ os: "linux" })).toContain('curl -fSL -o "$1" "$2"');
});

});
