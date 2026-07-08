import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetZigToolchainStateForTest,
    acquireZigToolchain,
    defaultZigToolchain,
    defaultZigToolchainVersion,
    installZigToolchain,
    zigArtifactName,
    zigCacheKey,
    zigBin,
    zigCMakeArgs,
    zigTool,
    zigToolchain,
} from "//rules/c/zig/toolchain";

function withZigHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetZigToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetZigToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("Zig toolchain", () => {
test("declares a default Zig toolchain", () => {
    return withZigHost((host) => {
        const toolchain = zigToolchain("0.13.0", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("0.13.0");
        expect(zigCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("0.13.0/linux-x86_64");
        expect(defaultZigToolchainVersion()).toBe("0.13.0");
        expect(defaultZigToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withZigHost(async () => {
        let message = null;

        try {
            await acquireZigToolchain("0.13.0");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no Zig toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withZigHost(async () => {
        zigToolchain("0.13.0");
        let message = null;

        try {
            await zigBin();
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no Zig toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withZigHost(async (host) => {
        const key = zigCacheKey("0.13.0", { os: "linux", arch: "x86_64" });
        // zigToolchain() is what normally sets up coreToolHandles;
        // installZigToolchain() alone (a manual/offline seeding path) only
        // ever populates ZIG_TOOLCHAIN_CACHE, so acquireZigToolchain still
        // needs a prior toolchain declaration to acquire from at all.
        zigToolchain("0.13.0");

        expect(
            installZigToolchain("0.13.0", "/tmp/zig-0.13.0"),
        ).toBe("/cache/zig-toolchains/0.13.0/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "zig-toolchains" && call[2] === key && call[3] === "/tmp/zig-0.13.0"),
        ).toBe(true);
        // Build cache already warm too (e.g. backfilled by a prior real
        // acquire), so nothing left for acquireZigToolchain to seed.
        host.install("zig-build-cache", key, "/tmp/zig-build-cache-0.13.0");

        expect(
            await acquireZigToolchain("0.13.0"),
        ).toBe("/cache/zig-toolchains/0.13.0/linux-x86_64");
        expect(
            await zigBin("0.13.0"),
        ).toBe("/cache/zig-toolchains/0.13.0/linux-x86_64/zig");
        // Both caches already warm, so no run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("describes the named-cache-backed zig tool", async () => {
    await withZigHost(async () => {
        installZigToolchain("0.13.0", "/tmp/zig-0.13.0");
        zigToolchain("0.13.0", { default: true });
        const tool = await zigTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("zig");
        expect(tool.cache).toBe("zig-toolchains");
        expect(tool.key).toBe("0.13.0/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe(".");
    });
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run() (linux)", async () => {
    await withZigHost(async (host) => {
        const key = zigCacheKey("0.13.0", { os: "linux", arch: "x86_64" });

        zigToolchain("0.13.0", { default: true });
        const path = await acquireZigToolchain("0.13.0");

        expect(path).toBe("/cache/zig-toolchains/0.13.0/linux-x86_64");
        // download, extract, and the zig-build-cache prewarm.
        expect(host.runs.length).toBe(3);

        const [download, extract, prewarm] = host.runs;
        expect(download.argv[0]).toBe("sh");
        // 0.13.0 predates the 0.14.1 filename-order switch, so it's
        // zig-<os>-<arch>-..., not zig-<arch>-<os>-....
        expect(download.argv.some((arg) => arg.includes("zig-linux-x86_64-0.13.0.tar.xz"))).toBe(true);
        expect(download.tools[0].name).toBe("curl");
        // Linux tar.xz decompression needs a separate xz process; Windows sh
        // isn't needed on this platform.
        expect(download.tools.some((t) => t.name === "xz")).toBe(true);
        expect(download.tools.some((t) => t.name === "sh")).toBe(false);

        expect(extract.argv[0]).toBe("sh");
        expect(extract.argv).toContain("zigar");
        expect(extract.argv).toContain("zigranlib");
        expect(extract.argv.some((arg) => typeof arg === "string" && arg.includes("#!/bin/sh"))).toBe(true);
        expect(extract.outputs[0].namedCache.name).toBe("zig-toolchains");
        expect(extract.outputs[0].namedCache.key).toBe(key);

        expect(prewarm.argv[0]).toBe("sh");
        expect(prewarm.tools.some((t) => t.name === "zig")).toBe(true);
        expect(prewarm.outputs[0].namedCache.name).toBe("zig-build-cache");
        expect(prewarm.outputs[0].namedCache.key).toBe(key);

        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
    });
});

test("downloads and extracts a toolchain on windows with .bat wrappers and a declared sh tool", async () => {
    await withZigHost({ os: "windows", arch: "x86_64" }, async (host) => {
        zigToolchain("0.13.0", { default: true });
        await acquireZigToolchain("0.13.0");

        const [download, extract] = host.runs;
        expect(download.argv.some((arg) => arg.includes("zig-windows-x86_64-0.13.0.zip"))).toBe(true);
        expect(download.tools.some((t) => t.name === "sh")).toBe(true);
        expect(download.tools.some((t) => t.name === "xz")).toBe(false);

        expect(extract.argv).toContain("zigar.bat");
        expect(extract.argv).toContain("zigranlib.bat");
        expect(extract.argv.some((arg) => typeof arg === "string" && arg.includes("@\"%~dp0zig.exe\" ar %*"))).toBe(true);
    });
});

test("describes the CMake -D flags for a linux toolchain", async () => {
    await withZigHost({ os: "linux", arch: "x86_64" }, async () => {
        zigToolchain("0.13.0", { default: true });

        const args = await zigCMakeArgs();

        expect(args).toEqual([
            "-DCMAKE_C_COMPILER=zig",
            "-DCMAKE_C_COMPILER_ARG1=cc",
            "-DCMAKE_CXX_COMPILER=zig",
            "-DCMAKE_CXX_COMPILER_ARG1=c++",
            "-DCMAKE_AR=.imp/tools/zig/zigar",
            "-DCMAKE_RANLIB=.imp/tools/zig/zigranlib",
        ]);
    });
});

test("uses legacy os-then-arch artifact naming through 0.14.0", () => {
    expect(zigArtifactName("0.13.0", { os: "linux", arch: "x86_64" })).toBe("zig-linux-x86_64-0.13.0.tar.xz");
    expect(zigArtifactName("0.14.0", { os: "windows", arch: "x86_64" })).toBe("zig-windows-x86_64-0.14.0.zip");
});

test("uses current arch-then-os artifact naming from 0.14.1 onward", () => {
    expect(zigArtifactName("0.14.1", { os: "linux", arch: "x86_64" })).toBe("zig-x86_64-linux-0.14.1.tar.xz");
    expect(zigArtifactName("0.16.0", { os: "windows", arch: "aarch64" })).toBe("zig-aarch64-windows-0.16.0.zip");
});

test("treats non-numeric versions (dev builds) as current naming", () => {
    expect(zigArtifactName("0.17.0-dev.1267+300116b02", { os: "linux", arch: "x86_64" }))
        .toBe("zig-x86_64-linux-0.17.0-dev.1267+300116b02.tar.xz");
});

test("describes the CMake -D flags for a windows toolchain", async () => {
    await withZigHost({ os: "windows", arch: "x86_64" }, async () => {
        zigToolchain("0.13.0", { default: true });

        const args = await zigCMakeArgs();

        expect(args).toEqual([
            "-DCMAKE_C_COMPILER=zig.exe",
            "-DCMAKE_C_COMPILER_ARG1=cc",
            "-DCMAKE_CXX_COMPILER=zig.exe",
            "-DCMAKE_CXX_COMPILER_ARG1=c++",
            "-DCMAKE_AR=.imp/tools/zig/zigar.bat",
            "-DCMAKE_RANLIB=.imp/tools/zig/zigranlib.bat",
        ]);
    });
});
});
