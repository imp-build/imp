import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    createOdinToolchainApi,
    odinArtifactName,
    odinCacheKey,
    odinDownloadUrl,
} from "//rules/odin/toolchain";

function fakeHost(plat = { os: "linux", arch: "x86_64" }) {
    const calls = [];
    const cache = new Map();

    return {
        calls,
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
        download(url) {
            calls.push(["download", url]);
            return "/downloads/odin-release";
        },
        extract(archive, dest, opts) {
            calls.push(["extract", archive, dest, opts.format, opts.strip_components]);
        },
        cachePut(name, key, source) {
            calls.push(["cachePut", name, key, source]);
            cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
        },
    };
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
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    const toolchain = api.odinToolchain("dev-2026-03", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.version).toBe("dev-2026-03");
    expect(toolchain.cacheKey).toBe("odin-toolchains/dev-2026-03/linux-x86_64");
    expect(api.defaultOdinToolchainVersion()).toBe("dev-2026-03");
    expect(api.defaultOdinToolchain()).toBe(toolchain);
    expect(host.calls[0][0]).toBe("namedCache");
});

test("installs a missing toolchain into the named cache", () => {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    const dir = api.acquireOdinToolchain("dev-2026-03");
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

test("uses an existing toolchain cache entry", () => {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    api.acquireOdinToolchain("dev-2026-03");
    host.calls.length = 0;

    const dir = api.acquireOdinToolchain("dev-2026-03");

    expect(dir).toBe("/cache/odin-toolchains/dev-2026-03/linux-x86_64");
    expect(host.calls.some((call) => call[0] === "download")).toBe(false);
    expect(host.calls.some((call) => call[0] === "extract")).toBe(false);
});

test("uses the default version for odin binary lookup", () => {
    const host = fakeHost({ os: "windows", arch: "x86_64" });
    const api = createOdinToolchainApi(host);

    api.odinToolchain("dev-2026-03", { default: true });

    expect(
        api.odinBin(),
    ).toBe("/cache/odin-toolchains/dev-2026-03/windows-x86_64/odin.exe");
});

test("describes the named-cache-backed odin tool", () => {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    api.odinToolchain("dev-2026-03", { default: true });
    const tool = api.odinTool();

    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("odin");
    expect(tool.cache).toBe("odin-toolchains");
    expect(tool.key).toBe("dev-2026-03/linux-x86_64");
    expect(tool.binDirs.join(",")).toBe(".");
});
});
