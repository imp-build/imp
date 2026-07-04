import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    createGccToolchainApi,
    gccCacheKey,
} from "//rules/c/gcc/toolchain";

function fakeHost(plat = { os: "linux", arch: "x86_64" }) {
    const calls = [];
    const runs = [];
    const cache = new Map();

    return {
        calls,
        runs,
        namedCache(opts) {
            calls.push(["namedCache", opts.name]);
        },
        platformInfo() {
            calls.push(["platformInfo"]);
            return plat;
        },
        cacheHas(name, key) {
            calls.push(["cacheHas", name, key]);
            return cache.has(`${name}/${key}`);
        },
        cacheGet(name, key) {
            calls.push(["cacheGet", name, key]);
            return cache.get(`${name}/${key}`) || null;
        },
        cachePut(name, key, source) {
            calls.push(["cachePut", name, key, source]);
            cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
        },
        nativeTool(name) {
            calls.push(["nativeTool", name]);
            return { __imp: true, attrs: { name } };
        },
        async nativeToolSpec(handle) {
            calls.push(["nativeToolSpec", handle.attrs.name]);
            return { kind: "tool", name: handle.attrs.name, cache: "native-tools", key: handle.attrs.name, binDirs: ["."] };
        },
        output(path, opts) {
            return { kind: (opts && opts.kind) || "file", path, ...(opts && opts.namedCache ? { namedCache: opts.namedCache } : {}) };
        },
        output_path(path) {
            return path;
        },
        async run(opts) {
            runs.push(opts);
            for (const out of opts.outputs || []) {
                if (out.namedCache) {
                    cache.set(`${out.namedCache.name}/${out.namedCache.key}`, `/cache/${out.namedCache.name}/${out.namedCache.key}`);
                }
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        },
    };
}

describe("gcc toolchain", () => {
test("declares a default gcc toolchain", () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);

    const toolchain = api.gccToolchain("2025.08-1", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.attrs.version).toBe("2025.08-1");
    expect(gccCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("2025.08-1/linux-x86_64");
    expect(api.defaultGccToolchainVersion()).toBe("2025.08-1");
    expect(api.defaultGccToolchain()).toBe(toolchain);
    expect(host.calls[0][0]).toBe("namedCache");
});

test("throws when no toolchain has been declared", async () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);
    let message = null;

    try {
        await api.acquireGccToolchain("2025.08-1");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no gcc toolchain declared");
});

test("throws when no version is given and no default is set", async () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);
    api.gccToolchain("2025.08-1");
    let message = null;

    try {
        await api.gccBin();
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no gcc toolchain version specified");
});

test("installs and acquires a toolchain from the named cache", async () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);
    const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });

    expect(
        api.installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1"),
    ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "gcc-toolchains" && call[2] === key && call[3] === "/tmp/gcc-2025.08-1"),
    ).toBe(true);

    expect(
        await api.acquireGccToolchain("2025.08-1"),
    ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64");
    expect(
        await api.gccBin("2025.08-1"),
    ).toBe("/cache/gcc-toolchains/2025.08-1/linux-x86_64/bin/x86_64-linux-gcc");
    // Already cached, so no download/extract run() should have happened.
    expect(host.runs.length).toBe(0);
});

test("describes the named-cache-backed gcc tool", async () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);

    api.installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
    api.gccToolchain("2025.08-1", { default: true });
    const tool = await api.gccTool();

    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("gcc-toolchain");
    expect(tool.cache).toBe("gcc-toolchains");
    expect(tool.key).toBe("2025.08-1/linux-x86_64");
    expect(tool.binDirs.join(",")).toBe("bin");
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run(), writing a clang wrapper", async () => {
    const host = fakeHost();
    const api = createGccToolchainApi(host);
    const key = gccCacheKey("2025.08-1", { os: "linux", arch: "x86_64" });

    api.gccToolchain("2025.08-1", { default: true });
    const path = await api.acquireGccToolchain("2025.08-1");

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
