import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    cmakeCacheKey,
    createCmakeToolchainApi,
} from "//rules/c/cmake/toolchain";

function fakeHost(plat = { os: "linux", arch: "x86_64" }) {
    const calls = [];
    const runs = [];
    const cache = new Map();

    return {
        calls,
        runs,
        install(name, key, path) {
            cache.set(`${name}/${key}`, path);
        },
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

describe("CMake toolchain", () => {
test("declares a default CMake toolchain", () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    const toolchain = api.cmakeToolchain("3.30.5", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.attrs.version).toBe("3.30.5");
    expect(cmakeCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("3.30.5/linux-x86_64");
    expect(api.defaultCmakeToolchainVersion()).toBe("3.30.5");
    expect(api.defaultCmakeToolchain()).toBe(toolchain);
    expect(host.calls[0][0]).toBe("namedCache");
});

test("uses system cmake without a declared toolchain", async () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    expect(await api.cmakeBin()).toBe("cmake");
});

test("installs and acquires a toolchain from the named cache", async () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

    expect(
        api.installCmakeToolchain("3.30.5", "/tmp/cmake-3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "cmake-toolchains" && call[2] === key && call[3] === "/tmp/cmake-3.30.5"),
    ).toBe(true);

    expect(
        await api.acquireCmakeToolchain("3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64");
    expect(
        await api.cmakeBin("3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64/bin/cmake");
    // Already cached, so no download/extract run() should have happened.
    expect(host.runs.length).toBe(0);
});

test("describes the named-cache-backed cmake tool", async () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    api.installCmakeToolchain("3.30.5", "/tmp/cmake-3.30.5");
    api.cmakeToolchain("3.30.5", { default: true });
    const tool = await api.cmakeTool();

    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("cmake");
    expect(tool.cache).toBe("cmake-toolchains");
    expect(tool.key).toBe("3.30.5/linux-x86_64");
    expect(tool.binDirs.join(",")).toBe("bin");
});

test("throws when no toolchain has been declared", async () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    let message = null;

    try {
        await api.acquireCmakeToolchain("3.30.5");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no CMake toolchain declared");
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run()", async () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

    api.cmakeToolchain("3.30.5", { default: true });
    const path = await api.acquireCmakeToolchain("3.30.5");

    expect(path).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64");
    expect(host.runs.length).toBe(2);

    const [download, extract] = host.runs;
    expect(download.argv[0]).toBe("sh");
    expect(download.argv.some((arg) => arg.includes("cmake-3.30.5-linux-x86_64.tar.gz"))).toBe(true);
    expect(download.tools[0].name).toBe("curl");

    expect(extract.argv[0]).toBe("sh");
    expect(extract.outputs[0].namedCache.name).toBe("cmake-toolchains");
    expect(extract.outputs[0].namedCache.key).toBe(key);

    expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
});
});
