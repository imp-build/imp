import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetCraneToolchainStateForTest,
    acquireCraneToolchain,
    craneArtifactName,
    craneBin,
    craneCacheKey,
    craneDownloadUrl,
    craneTool,
    craneToolchain,
    defaultCraneToolchain,
    defaultCraneToolchainVersion,
    installCraneToolchain,
} from "//rules/oci/toolchain";

function withCraneHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetCraneToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetCraneToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("crane toolchain", () => {
test("builds artifact name / download URL per platform", () => {
    expect(craneArtifactName("0.20.6", { os: "linux", arch: "x86_64" })).toBe(
        "go-containerregistry_Linux_x86_64.tar.gz",
    );
    expect(craneArtifactName("0.20.6", { os: "macos", arch: "aarch64" })).toBe(
        "go-containerregistry_Darwin_arm64.tar.gz",
    );
    expect(craneArtifactName("0.20.6", { os: "windows", arch: "x86_64" })).toBe(
        "go-containerregistry_Windows_x86_64.tar.gz",
    );
    expect(craneDownloadUrl("0.20.6", { os: "linux", arch: "x86_64" })).toBe(
        "https://github.com/google/go-containerregistry/releases/download/v0.20.6/go-containerregistry_Linux_x86_64.tar.gz",
    );
    expect(craneCacheKey("0.20.6", { os: "linux", arch: "x86_64" })).toBe("0.20.6/linux-x86_64");
});

test("declares a default crane toolchain", () => {
    return withCraneHost((host) => {
        const toolchain = craneToolchain("0.20.6", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("0.20.6");
        expect(defaultCraneToolchainVersion()).toBe("0.20.6");
        expect(defaultCraneToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withCraneHost(async () => {
        let message = null;

        try {
            await acquireCraneToolchain("0.20.6");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no crane toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withCraneHost(async () => {
        craneToolchain("0.20.6");
        let message = null;

        try {
            await craneBin();
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no crane toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withCraneHost(async (host) => {
        const key = craneCacheKey("0.20.6", { os: "linux", arch: "x86_64" });

        expect(
            installCraneToolchain("0.20.6", "/tmp/crane-0.20.6"),
        ).toBe("/cache/crane-toolchains/0.20.6/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "crane-toolchains" && call[2] === key && call[3] === "/tmp/crane-0.20.6"),
        ).toBe(true);

        expect(
            await acquireCraneToolchain("0.20.6"),
        ).toBe("/cache/crane-toolchains/0.20.6/linux-x86_64");
        expect(
            await craneBin("0.20.6"),
        ).toBe("/cache/crane-toolchains/0.20.6/linux-x86_64/crane");
        // Already cached, so no download/extract run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("describes the named-cache-backed crane tool", async () => {
    await withCraneHost(async () => {
        installCraneToolchain("0.20.6", "/tmp/crane-0.20.6");
        craneToolchain("0.20.6", { default: true });
        const tool = await craneTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("crane");
        expect(tool.cache).toBe("crane-toolchains");
        expect(tool.key).toBe("0.20.6/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe(".");
    });
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run()", async () => {
    await withCraneHost(async (host) => {
        const key = craneCacheKey("0.20.6", { os: "linux", arch: "x86_64" });

        craneToolchain("0.20.6", { default: true });
        const path = await acquireCraneToolchain("0.20.6");

        expect(path).toBe("/cache/crane-toolchains/0.20.6/linux-x86_64");
        expect(host.runs.length).toBe(2);

        const [download, extract] = host.runs;
        expect(download.argv[0]).toBe("sh");
        expect(download.argv.some((arg) => arg.includes("go-containerregistry_Linux_x86_64.tar.gz"))).toBe(true);
        expect(download.tools[0].name).toBe("curl");
        expect(download.tools.some((t) => t.name === "gzip")).toBe(true);

        expect(extract.argv[0]).toBe("sh");
        expect(extract.outputs[0].namedCache.name).toBe("crane-toolchains");
        expect(extract.outputs[0].namedCache.key).toBe(key);

        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
    });
});

test("throws for an unsupported platform", () => {
    let message = null;
    try {
        craneArtifactName("0.20.6", { os: "freebsd", arch: "x86_64" });
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("unsupported crane toolchain platform");
});
});
