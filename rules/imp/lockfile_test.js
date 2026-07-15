import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    downloadToolArtifact,
    lockfileAddressToPath,
    resolveToolLockfile,
    lockedDownloadArgv,
    lockedDownloadTools,
    shaToolName,
} from "//rules/imp/lockfile";

const ADDRESS = "//rules/python/ruff-toolchain.lock";
const PLAT = { os: "linux", arch: "x86_64" };

function lockJson(overrides = {}) {
    return JSON.stringify({
        tool: "ruff-toolchain",
        versions: {
            "0.15.21": {
                "linux/x86_64": {
                    url: "https://example.com/ruff.tar.gz",
                    artifact: "ruff.tar.gz",
                    size: 12345,
                    sha256: "abc123",
                },
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
        expect(entry.size).toBe(12345);
    });
});

test("every locked version stays resolvable (additive downgrade path)", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(
            ADDRESS,
            JSON.stringify({
                tool: "ruff-toolchain",
                versions: {
                    "0.15.20": {
                        "linux/x86_64": { url: "https://example.com/old.tar.gz", artifact: "old.tar.gz", size: 1, sha256: "old" },
                    },
                    "0.15.21": {
                        "linux/x86_64": { url: "https://example.com/new.tar.gz", artifact: "new.tar.gz", size: 2, sha256: "new" },
                    },
                },
            }),
        );
        const resolve = (version) =>
            resolveToolLockfile({ address: ADDRESS, tool: "ruff-toolchain", version, plat: PLAT });
        expect(resolve("0.15.21").sha256).toBe("new");
        expect(resolve("0.15.20").sha256).toBe("old");
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

test("tool mismatch throws", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson({ tool: "other-tool" }));
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
        expect(message).toContain("pins other-tool, not ruff-toolchain");
    });
});

test("unlocked version throws, listing the locked ones", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson());
        let message = null;
        try {
            resolveToolLockfile({
                address: ADDRESS,
                tool: "ruff-toolchain",
                version: "0.15.22",
                plat: PLAT,
            });
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no entry for ruff-toolchain 0.15.22");
        expect(message).toContain("locked versions: 0.15.21");
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
        expect(message).toContain("platform macos/aarch64");
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

test("selects the sha tool per platform", () => {
    expect(shaToolName({ os: "linux" })).toBe("sha256sum");
    expect(shaToolName({ os: "windows" })).toBe("sha256sum");
    expect(shaToolName({ os: "macos" })).toBe("shasum");
});

test("locked download argv verifies sha256 and size", () => {
    const argv = lockedDownloadArgv({
        plat: { os: "linux" },
        lockEntry: { url: "https://example.com/a.tar.gz", size: 12345, sha256: "abc123" },
        url: "https://example.com/a.tar.gz",
        downloadPath: "/dl/a.tar.gz",
        displayName: "download-a",
    });
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = argv[2];
    expect(script).toContain('curl -fSL -o "$1" "$2"');
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain("size mismatch");
    expect(argv.slice(3)).toEqual([
        "download-a",
        "/dl/a.tar.gz",
        "https://example.com/a.tar.gz",
        "abc123",
        "12345",
    ]);
});

test("locked download argv skips the size check for entries without size", () => {
    const argv = lockedDownloadArgv({
        plat: { os: "macos" },
        lockEntry: { url: "https://example.com/a.tar.gz", sha256: "abc123" },
        url: "https://example.com/a.tar.gz",
        downloadPath: "/dl/a.tar.gz",
        displayName: "download-a",
    });
    const script = argv[2];
    expect(script).toContain("shasum -a 256 -c -");
    expect(script.includes("size mismatch")).toBe(false);
    expect(argv.slice(3)).toEqual([
        "download-a",
        "/dl/a.tar.gz",
        "https://example.com/a.tar.gz",
        "abc123",
    ]);
});

test("locked download argv without a lock entry is a plain download", () => {
    const argv = lockedDownloadArgv({
        plat: { os: "linux" },
        lockEntry: null,
        url: "https://example.com/a.tar.gz",
        downloadPath: "/dl/a.tar.gz",
        displayName: "download-a",
    });
    const script = argv[2];
    expect(script).toContain('curl -fSL -o "$1" "$2"');
    expect(script.includes("sha256sum")).toBe(false);
    expect(argv.slice(3)).toEqual(["download-a", "/dl/a.tar.gz", "https://example.com/a.tar.gz"]);
});

test("downloadToolArtifact runs a verified download from the lock entry", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson());
        const path = await downloadToolArtifact({
            lockfile: ADDRESS,
            tool: "ruff-toolchain",
            version: "0.15.21",
            plat: PLAT,
            url: "https://fallback.example/ruff.tar.gz",
            downloadPath: ".imp/downloads/ruff.tar.gz",
            tools: [],
            display: "download ruff",
        });

        expect(path).toBe(".imp/downloads/ruff.tar.gz");
        expect(host.runs.length).toBe(1);
        const [download] = host.runs;
        // The lock entry's URL wins over the caller's fallback.
        expect(download.argv).toContain("https://example.com/ruff.tar.gz");
        expect(download.argv[2]).toContain("sha256sum -c -");
    });
});

test("downloadToolArtifact decorates a failed verified download with a gen-lockfiles hint", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile(ADDRESS, lockJson());
        globalThis.__host_run = async () => {
            throw new Error("exit code 1");
        };
        let message = null;
        try {
            await downloadToolArtifact({
                lockfile: ADDRESS,
                tool: "ruff-toolchain",
                version: "0.15.21",
                plat: PLAT,
                url: "https://fallback.example/ruff.tar.gz",
                downloadPath: ".imp/downloads/ruff.tar.gz",
                tools: [],
                display: "download ruff",
            });
        } catch (e) {
            message = e.message;
        }
        expect(message).toContain("failed transfer or size/sha256 verification");
        expect(message).toContain("gen-lockfiles");
    });
});

test("downloadToolArtifact resolves lock entries under lockPlat when it differs from the host", async () => {
    await withFakeToolchainHost(async (host) => {
        host.addFile("//locks/pex.lock", JSON.stringify({
            tool: "pex-toolchain",
            versions: {
                "2.97.1": {
                    "any/any": {
                        url: "https://example.com/pex",
                        artifact: "pex",
                        sha256: "cafe",
                    },
                },
            },
        }));
        await downloadToolArtifact({
            lockfile: "//locks/pex.lock",
            tool: "pex-toolchain",
            version: "2.97.1",
            plat: PLAT,
            lockPlat: { os: "any", arch: "any" },
            url: "https://fallback.example/pex",
            downloadPath: ".imp/downloads/pex",
            tools: [],
            display: "download pex",
        });

        const [download] = host.runs;
        expect(download.argv).toContain("https://example.com/pex");
        expect(download.argv).toContain("cafe");
    });
});

test("locked download tool list covers the script per platform", () => {
    expect(lockedDownloadTools({ os: "linux" })).toEqual([
        "curl", "mkdir", "dirname", "wc", "sha256sum",
    ]);
    expect(lockedDownloadTools({ os: "windows" })).toEqual([
        "curl", "mkdir", "dirname", "wc", "sha256sum", "sh",
    ]);
    expect(lockedDownloadTools({ os: "macos" })).toEqual([
        "curl", "mkdir", "dirname", "wc", "shasum",
    ]);
});

});
