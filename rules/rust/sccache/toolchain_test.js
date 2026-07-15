import { productFor } from "imp:core";
import { RUST_BUILD_CACHE } from "//rules/rust/products";
import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetSccacheToolchainStateForTest,
    acquireSccacheToolchain,
    defaultSccacheToolchain,
    defaultSccacheToolchainVersion,
    installSccacheToolchain,
    sccacheCacheKey,
    sccacheDataDir,
    sccacheTool,
    sccacheToolchain,
} from "//rules/rust/sccache/toolchain";

function withSccacheHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetSccacheToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetSccacheToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("sccache toolchain", () => {
test("declares a default sccache toolchain", () => {
    return withSccacheHost((host) => {
        const toolchain = sccacheToolchain("0.10.0", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("0.10.0");
        expect(sccacheCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("0.10.0/linux-x86_64");
        expect(defaultSccacheToolchainVersion()).toBe("0.10.0");
        expect(defaultSccacheToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withSccacheHost(async () => {
        let message = null;

        try {
            await acquireSccacheToolchain("0.10.0");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no sccache toolchain declared");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withSccacheHost(async (host) => {
        const key = sccacheCacheKey("0.10.0", { os: "linux", arch: "x86_64" });

        expect(
            installSccacheToolchain("0.10.0", "/tmp/sccache-0.10.0"),
        ).toBe("/cache/sccache-toolchains/0.10.0/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "sccache-toolchains" && call[2] === key && call[3] === "/tmp/sccache-0.10.0"),
        ).toBe(true);

        expect(
            await acquireSccacheToolchain("0.10.0"),
        ).toBe("/cache/sccache-toolchains/0.10.0/linux-x86_64");
        // Already cached, so no download/extract run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
    await withSccacheHost(async (host) => {
        const key = sccacheCacheKey("0.10.0", { os: "linux", arch: "x86_64" });
        host.addFile("//rules/rust/sccache/sccache.lock", JSON.stringify({
            tool: "sccache",
            versions: {
                "0.10.0": {
                    "linux/x86_64": {
                        url: "https://locked.example/sccache-v0.10.0-x86_64-unknown-linux-musl.tar.gz",
                        artifact: "sccache-v0.10.0-x86_64-unknown-linux-musl.tar.gz",
                        size: 12345,
                        sha256: "deadbeef",
                    },
                },
            },
        }));

        sccacheToolchain("0.10.0", { default: true });
        const path = await acquireSccacheToolchain("0.10.0");

        expect(path).toBe("/cache/sccache-toolchains/0.10.0/linux-x86_64");
        expect(host.runs.length).toBe(2);

        const [download, extract] = host.runs;
        expect(download.argv[0]).toBe("sh");
        expect(download.argv).toContain("https://locked.example/sccache-v0.10.0-x86_64-unknown-linux-musl.tar.gz");
        expect(download.argv).toContain("deadbeef");
        expect(download.argv[2]).toContain("sha256sum -c -");
        expect(extract.argv[2]).toContain("--strip-components=1");
        expect(extract.outputs[0].namedCache.name).toBe("sccache-toolchains");
        expect(extract.outputs[0].namedCache.key).toBe(key);

        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
    });
});

test("describes the named-cache-backed sccache tool", async () => {
    await withSccacheHost(async () => {
        installSccacheToolchain("0.10.0", "/tmp/sccache-0.10.0");
        sccacheToolchain("0.10.0", { default: true });
        const tool = await sccacheTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("sccache");
        expect(tool.cache).toBe("sccache-toolchains");
        expect(tool.key).toBe("0.10.0/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe(".");
    });
});

test("seeds the sccache data directory once, then reuses it from the named cache", async () => {
    await withSccacheHost(async (host) => {
        sccacheToolchain("0.10.0", { default: true });

        const first = await sccacheDataDir();
        expect(first).toBe("/cache/sccache-data/linux-x86_64");
        expect(host.runs.length).toBe(1);
        expect(host.runs[0].outputs[0].namedCache.name).toBe("sccache-data");

        const second = await sccacheDataDir();
        expect(second).toBe(first);
        // Already seeded, so no second init run() should have happened.
        expect(host.runs.length).toBe(1);
    });
});

test("registers a rust-build-cache product exposing RUSTC_WRAPPER/SCCACHE_DIR and tools", async () => {
    await withSccacheHost(async (host) => {
        installSccacheToolchain("0.10.0", "/tmp/sccache-0.10.0");
        const toolchain = sccacheToolchain("0.10.0");

        const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);

        expect(await wrapper.env()).toEqual([
            "SCCACHE_DIR=/cache/sccache-data/linux-x86_64",
            "RUSTC_WRAPPER=sccache",
            "CARGO_INCREMENTAL=0",
        ]);
        const tools = await wrapper.tools();
        expect(tools.some((t) => t.name === "sccache")).toBe(true);
    });
});

test("env() starts the sccache worker via the host worker registry", async () => {
    await withSccacheHost(async (host) => {
        installSccacheToolchain("0.10.0", "/tmp/sccache-0.10.0");
        const toolchain = sccacheToolchain("0.10.0");

        const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);
        await wrapper.env();

        const [name, opts] = host.calls.find((call) => call[0] === "workerStart").slice(1);
        expect(name).toBe("sccache");
        expect(opts.argv.some((arg) => arg.endsWith("/sccache"))).toBe(true);
        expect(opts.argv).toContain("--start-server");
        expect(opts.healthCheckArgv).toContain("--show-stats");
        expect(opts.env.some((e) => e.startsWith("SCCACHE_DIR="))).toBe(true);
    });
});
});
