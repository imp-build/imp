import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetGccToolchainStateForTest,
    acquireGccToolchain,
    defaultGccToolchain,
    defaultGccToolchainVersion,
    gccCacheKey,
    gccBin,
    gccTool,
    gccToolchain,
    installGccToolchain,
} from "//rules/c/gcc/toolchain";

function withGccHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetGccToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetGccToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("gcc toolchain", () => {
test("declares a default gcc toolchain", () => {
    return withGccHost((host) => {
        const toolchain = gccToolchain("2025.08-1", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("2025.08-1");
        expect(gccCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("2025.08-1/linux-x86_64");
        expect(defaultGccToolchainVersion()).toBe("2025.08-1");
        expect(defaultGccToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withGccHost(async () => {
        let message = null;

        try {
            await acquireGccToolchain("2025.08-1");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no gcc toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withGccHost(async () => {
        gccToolchain("2025.08-1");
        let message = null;

        try {
            await gccBin();
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no gcc toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withGccHost(async (host) => {
        const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });

        expect(
            installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1"),
        ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "gcc-toolchains" && call[2] === key && call[3] === "/tmp/gcc-2025.08-1"),
        ).toBe(true);

        expect(
            await acquireGccToolchain("2025.08-1"),
        ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
        expect(
            await gccBin("2025.08-1"),
        ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/x86_64-linux-gcc");
        // Already cached, so no download/extract run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("describes the named-cache-backed gcc tool", async () => {
    await withGccHost(async () => {
        installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
        gccToolchain("2025.08-1", { default: true });
        const tool = await gccTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("gcc-toolchain");
        expect(tool.cache).toBe("gcc-toolchains");
        expect(tool.key).toBe("2025.08-1/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe("bin");
    });
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run(), writing a clang wrapper", async () => {
    await withGccHost(async (host) => {
        const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });

        gccToolchain("2025.08-1", { default: true });
        const path = await acquireGccToolchain("2025.08-1");

        expect(path).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
        expect(host.runs.length).toBe(2);

        const [download, extract] = host.runs;
        expect(download.argv[0]).toBe("sh");
        expect(download.argv.some((arg) => arg.includes("x86-64--glibc--stable-2025.08-1.tar.xz"))).toBe(true);
        expect(download.tools[0].name).toBe("curl");
        expect(download.tools.some((t) => t.name === "xz")).toBe(true);

        expect(extract.argv[0]).toBe("sh");
        expect(extract.argv).toContain("clang");
        expect(extract.argv).toContain("ar");
        expect(extract.argv.some((arg) => typeof arg === "string" && arg.includes("#!/bin/sh") && arg.includes("x86_64-linux-gcc"))).toBe(true);
        expect(extract.argv.some((arg) => typeof arg === "string" && arg.includes("#!/bin/sh") && arg.includes("x86_64-buildroot-linux-gnu-ar"))).toBe(true);
        expect(extract.outputs[0].namedCache.name).toBe("gcc-toolchains");
        expect(extract.outputs[0].namedCache.key).toBe(key);

        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
    });
});
});
