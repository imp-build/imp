import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    createZolaToolchainApi,
    zolaArtifactName,
    zolaDownloadUrl,
    zolaCacheKey,
} from "//rules/zola/toolchain";

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

describe("zola toolchain", () => {
test("builds artifact name / download URL per platform", () => {
    expect(zolaArtifactName("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
        "zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
    );
    expect(zolaArtifactName("0.22.1", { os: "macos", arch: "aarch64" })).toBe(
        "zola-v0.22.1-aarch64-apple-darwin.tar.gz",
    );
    expect(zolaArtifactName("0.22.1", { os: "windows", arch: "x86_64" })).toBe(
        "zola-v0.22.1-x86_64-pc-windows-msvc.zip",
    );
    expect(zolaDownloadUrl("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
        "https://github.com/getzola/zola/releases/download/v0.22.1/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
    );
    expect(zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" })).toBe("0.22.1/linux-x86_64");
});

test("declares a default zola toolchain", () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);

    const toolchain = api.zolaToolchain("0.22.1", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.attrs.version).toBe("0.22.1");
    expect(api.defaultZolaToolchainVersion()).toBe("0.22.1");
    expect(api.defaultZolaToolchain()).toBe(toolchain);
    expect(host.calls[0][0]).toBe("namedCache");
});

test("throws when no toolchain has been declared", async () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);
    let message = null;

    try {
        await api.acquireZolaToolchain("0.22.1");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no zola toolchain declared");
});

test("throws when no version is given and no default is set", async () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);
    api.zolaToolchain("0.22.1");
    let message = null;

    try {
        await api.zolaBin();
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no zola toolchain version specified");
});

test("installs and acquires a toolchain from the named cache", async () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);
    const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });

    expect(
        api.installZolaToolchain("0.22.1", "/tmp/zola-0.22.1"),
    ).toBe("/cache/zola-toolchains/0.22.1/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "zola-toolchains" && call[2] === key && call[3] === "/tmp/zola-0.22.1"),
    ).toBe(true);

    expect(
        await api.acquireZolaToolchain("0.22.1"),
    ).toBe("/cache/zola-toolchains/0.22.1/linux-x86_64");
    expect(
        await api.zolaBin("0.22.1"),
    ).toBe("/cache/zola-toolchains/0.22.1/linux-x86_64/zola");
    // Already cached, so no download/extract run() should have happened.
    expect(host.runs.length).toBe(0);
});

test("describes the named-cache-backed zola tool", async () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);

    api.installZolaToolchain("0.22.1", "/tmp/zola-0.22.1");
    api.zolaToolchain("0.22.1", { default: true });
    const tool = await api.zolaTool();

    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("zola");
    expect(tool.cache).toBe("zola-toolchains");
    expect(tool.key).toBe("0.22.1/linux-x86_64");
    expect(tool.binDirs.join(",")).toBe(".");
});

test("downloads and extracts a toolchain via a sandboxed curl+tar run()", async () => {
    const host = fakeHost();
    const api = createZolaToolchainApi(host);
    const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });

    api.zolaToolchain("0.22.1", { default: true });
    const path = await api.acquireZolaToolchain("0.22.1");

    expect(path).toBe("/cache/zola-toolchains/0.22.1/linux-x86_64");
    expect(host.runs.length).toBe(2);

    const [download, extract] = host.runs;
    expect(download.argv[0]).toBe("sh");
    expect(download.argv.some((arg) => arg.includes("zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz"))).toBe(true);
    expect(download.tools[0].name).toBe("curl");
    expect(download.tools.some((t) => t.name === "gzip")).toBe(true);

    expect(extract.argv[0]).toBe("sh");
    expect(extract.outputs[0].namedCache.name).toBe("zola-toolchains");
    expect(extract.outputs[0].namedCache.key).toBe(key);

    expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
});

test("throws for an unsupported platform", () => {
    let message = null;
    try {
        zolaArtifactName("0.22.1", { os: "freebsd", arch: "x86_64" });
    } catch (error) {
        message = error.message;
    }
    expect(message).toContain("unsupported zola toolchain platform");
});
});
