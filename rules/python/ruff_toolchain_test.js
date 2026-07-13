import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    __resetRuffToolchainStateForTest,
    acquireRuffToolchain,
    defaultRuffToolchain,
    defaultRuffToolchainVersion,
    installRuffToolchain,
    ruffArtifactName,
    ruffBin,
    ruffCacheKey,
    ruffDownloadUrl,
    ruffTool,
    ruffToolchain,
} from "//rules/python/ruff_toolchain";

function withRuffHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetRuffToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetRuffToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("ruff toolchain", () => {

test("declares a default ruff toolchain", () => {
    return withRuffHost((host) => {
        const toolchain = ruffToolchain("0.15.21", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("0.15.21");
        expect(defaultRuffToolchainVersion()).toBe("0.15.21");
        expect(defaultRuffToolchain()).toBe(toolchain);
        expect(host.calls.some((call) => call[0] === "namedCache" && call[1] === "ruff-toolchains")).toBe(true);
    });
});

test("computes artifact name and download URL per platform", () => {
    return withRuffHost(() => {
        const plat = { os: "linux", arch: "x86_64" };
        expect(ruffArtifactName("0.15.21", plat)).toBe("ruff-x86_64-unknown-linux-gnu.tar.gz");
        expect(ruffDownloadUrl("0.15.21", plat)).toBe(
            "https://github.com/astral-sh/ruff/releases/download/0.15.21/ruff-x86_64-unknown-linux-gnu.tar.gz",
        );
        expect(ruffCacheKey("0.15.21", plat)).toBe("0.15.21/linux-x86_64");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withRuffHost(async () => {
        let message = null;
        try {
            await acquireRuffToolchain("0.15.21");
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no ruff toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withRuffHost(async () => {
        ruffToolchain("0.15.21");
        let message = null;
        try {
            await ruffBin();
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no ruff toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withRuffHost(async (host) => {
        const key = ruffCacheKey("0.15.21", { os: "linux", arch: "x86_64" });

        const seeded = installRuffToolchain("0.15.21", "/tmp/ruff");
        expect(seeded).toBe(`/cache/ruff-toolchains/${key}`);

        ruffToolchain("0.15.21", { default: true });
        expect(await acquireRuffToolchain("0.15.21")).toBe(`/cache/ruff-toolchains/${key}`);
        expect(await ruffBin("0.15.21")).toBe(`/cache/ruff-toolchains/${key}/ruff`);
        // Already cached, so no download/extract run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("downloads, verifies, and extracts ruff via two sandboxed runs when not cached", async () => {
    await withRuffHost(async (host) => {
        host.addFile("//rules/python/ruff-toolchain.lock", JSON.stringify({
            tool: "ruff-toolchain",
            versions: {
                "0.15.21": {
                    "linux/x86_64": {
                        url: "https://locked.example/ruff-x86_64-unknown-linux-gnu.tar.gz",
                        artifact: "ruff-x86_64-unknown-linux-gnu.tar.gz",
                        size: 12345,
                        sha256: "deadbeef",
                    },
                },
            },
        }));
        ruffToolchain("0.15.21", { default: true });
        const tool = await ruffTool("0.15.21");

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("ruff");
        expect(tool.binDirs).toEqual(["."]);
        expect(host.runs.length).toBe(2);

        const [download, extract] = host.runs;
        // The lock entry pins both the URL and the expected digest.
        expect(download.argv).toContain("https://locked.example/ruff-x86_64-unknown-linux-gnu.tar.gz");
        expect(download.argv).toContain("deadbeef");
        expect(download.argv[2]).toContain("sha256sum -c -");
        expect(extract.argv[2]).toContain("--strip-components=1");
    });
});

test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
    await withRuffHost(async () => {
        ruffToolchain("0.15.21", { default: true });
        let message = null;
        try {
            await ruffTool("0.15.21");
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("no lockfile found");
        expect(message).toContain("gen-lockfiles");
    });
});

test("unverified: true downloads without a sha check", async () => {
    await withRuffHost(async (host) => {
        ruffToolchain("0.15.21", { default: true, unverified: true });
        await ruffTool("0.15.21");

        expect(host.runs.length).toBe(2);
        const [download] = host.runs;
        expect(download.argv).toContain(
            "https://github.com/astral-sh/ruff/releases/download/0.15.21/ruff-x86_64-unknown-linux-gnu.tar.gz",
        );
        expect(download.argv[2]).not.toContain("sha256sum");
    });
});

test("a custom lockfile address is consulted instead of the bundled one", async () => {
    await withRuffHost(async (host) => {
        host.addFile("//locks/ruff.lock", JSON.stringify({
            tool: "ruff-toolchain",
            versions: {
                "0.15.22": {
                    "linux/x86_64": { url: "https://locked.example/ruff.tar.gz", artifact: "ruff.tar.gz", size: 99, sha256: "cafe" },
                },
            },
        }));
        ruffToolchain("0.15.22", { default: true, lockfile: "//locks/ruff.lock" });
        await ruffTool("0.15.22");

        expect(host.calls.some((call) => call[0] === "readAddressedFile" && call[1] === "//locks/ruff.lock")).toBe(true);
        expect(host.runs[0].argv).toContain("cafe");
    });
});

test("uses the windows target triple and archive extension", () => {
    return withRuffHost({ os: "windows", arch: "x86_64" }, () => {
        const plat = { os: "windows", arch: "x86_64" };
        expect(ruffArtifactName("0.15.21", plat)).toBe("ruff-x86_64-pc-windows-msvc.zip");
    });
});

});
