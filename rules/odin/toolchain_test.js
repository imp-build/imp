import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetOdinToolchainStateForTest,
    acquireOdinToolchain,
    defaultOdinToolchain,
    defaultOdinToolchainVersion,
    odinArtifactName,
    odinBin,
    odinCacheKey,
    odinDownloadUrl,
    odinTool,
    odinToolchain,
} from "//rules/odin/toolchain";

function withOdinHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetOdinToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetOdinToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("Odin toolchain", () => {
test("formats release artifact names", () => {
    expect(
        odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
    ).toBe("odin-linux-amd64-dev-2026-03.tar.gz");
    expect(
        odinArtifactName("dev-2026-03", { os: "macos", arch: "aarch64" }),
    ).toBe("odin-macos-arm64-dev-2026-03.tar.gz");
    expect(
        odinArtifactName("dev-2026-03", { os: "windows", arch: "x86_64" }),
    ).toBe("odin-windows-amd64-dev-2026-03.zip");
});

test("declares a default toolchain target", () => {
    return withOdinHost((host) => {
        const toolchain = odinToolchain("dev-2026-03", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("dev-2026-03");
        expect(odinCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("dev-2026-03/linux-x86_64");
        expect(defaultOdinToolchainVersion()).toBe("dev-2026-03");
        expect(defaultOdinToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("installs a missing toolchain into the named cache", () => {
    return withOdinHost((host) => {
        const dir = acquireOdinToolchain("dev-2026-03");
        const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });

        expect(dir).toBe(`/cache/odin-toolchains/${key}`);
        expect(
            host.calls.some((call) => call[0] === "download" && call[1] === odinDownloadUrl("dev-2026-03", { os: "linux", arch: "x86_64" })),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "extract" && call[1] === "/downloads/odin-release" && call[2] === "/tmp/imp-odin-dev-2026-03-x86_64" && call[3] === "tar.gz" && call[4] === 1),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "odin-toolchains" && call[2] === key && call[3] === "/tmp/imp-odin-dev-2026-03-x86_64"),
        ).toBe(true);
    });
});

test("uses an existing toolchain cache entry", () => {
    return withOdinHost((host) => {
        acquireOdinToolchain("dev-2026-03");
        host.clearCalls();

        const dir = acquireOdinToolchain("dev-2026-03");

        expect(dir).toBe("/cache/odin-toolchains/dev-2026-03/linux-x86_64");
        expect(host.calls.some((call) => call[0] === "download")).toBe(false);
        expect(host.calls.some((call) => call[0] === "extract")).toBe(false);
    });
});

test("uses the default version for odin binary lookup", () => {
    return withOdinHost({ os: "windows", arch: "x86_64" }, () => {
        odinToolchain("dev-2026-03", { default: true });

        expect(
            odinBin(),
        ).toBe("/cache/odin-toolchains/dev-2026-03/windows-x86_64/odin.exe");
    });
});

test("describes the named-cache-backed odin tool", () => {
    return withOdinHost(() => {
        odinToolchain("dev-2026-03", { default: true });
        const tool = odinTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("odin");
        expect(tool.cache).toBe("odin-toolchains");
        expect(tool.key).toBe("dev-2026-03/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe(".");
    });
});

});
