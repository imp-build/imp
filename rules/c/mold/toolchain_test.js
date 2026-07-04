import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    createMoldToolchainApi,
    moldCacheKey,
} from "//rules/c/mold/toolchain";

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

describe("mold toolchain", () => {
test("declares a default mold toolchain", () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);

    const toolchain = api.moldToolchain("2.41.0", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.attrs.version).toBe("2.41.0");
    expect(moldCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("2.41.0/linux-x86_64");
    expect(api.defaultMoldToolchainVersion()).toBe("2.41.0");
    expect(api.defaultMoldToolchain()).toBe(toolchain);
    expect(host.calls[0][0]).toBe("namedCache");
});

test("throws when no toolchain has been declared", async () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);
    let message = null;

    try {
        await api.acquireMoldToolchain("2.41.0");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no mold toolchain declared");
});

test("throws when no version is given and no default is set", async () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);
    api.moldToolchain("2.41.0");
    let message = null;

    try {
        await api.moldBin();
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no mold toolchain version specified");
});

test("installs and acquires a toolchain from the named cache", async () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);
    const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });

    expect(
        api.installMoldToolchain("2.41.0", "/tmp/mold-2.41.0"),
    ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "mold-toolchains" && call[2] === key && call[3] === "/tmp/mold-2.41.0"),
    ).toBe(true);

    expect(
        await api.acquireMoldToolchain("2.41.0"),
    ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
    expect(
        await api.moldBin("2.41.0"),
    ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64/bin/mold");
    // Already cached, so no download/extract run() should have happened.
    expect(host.runs.length).toBe(0);
});

test("describes the named-cache-backed mold tool", async () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);

    api.installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
    api.moldToolchain("2.41.0", { default: true });
    const tool = await api.moldTool();

    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("mold");
    expect(tool.cache).toBe("mold-toolchains");
    expect(tool.key).toBe("2.41.0/linux-x86_64");
    expect(tool.binDirs.join(",")).toBe("bin");
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run()", async () => {
    const host = fakeHost();
    const api = createMoldToolchainApi(host);
    const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });

    api.moldToolchain("2.41.0", { default: true });
    const path = await api.acquireMoldToolchain("2.41.0");

    expect(path).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
    expect(host.runs.length).toBe(2);

    const [download, extract] = host.runs;
    expect(download.argv[0]).toBe("sh");
    expect(download.argv.some((arg) => arg.includes("mold-2.41.0-x86_64-linux.tar.gz"))).toBe(true);
    expect(download.tools[0].name).toBe("curl");
    expect(download.tools.some((t) => t.name === "gzip")).toBe(true);

    expect(extract.argv[0]).toBe("sh");
    expect(extract.outputs[0].namedCache.name).toBe("mold-toolchains");
    expect(extract.outputs[0].namedCache.key).toBe(key);

    expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
});
});
