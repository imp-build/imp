import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    createRustToolchainApi,
    rustCacheKey,
} from "//rules/rust/toolchain";

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

const SEED = { rustupHome: "/tmp/rustup", cargoHome: "/tmp/cargo" };

describe("rust toolchain", () => {
test("declares a default rust toolchain and both caches", () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);

    const toolchain = api.rustToolchain("1.79.0", { default: true });

    expect(toolchain.__imp).toBe(true);
    expect(toolchain.attrs.version).toBe("1.79.0");
    expect(rustCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("1.79.0/linux-x86_64");
    expect(api.defaultRustToolchainVersion()).toBe("1.79.0");
    expect(api.defaultRustToolchain()).toBe(toolchain);
    // Both RUSTUP_HOME and CARGO_HOME caches are declared up front.
    const declared = host.calls.filter((call) => call[0] === "namedCache").map((call) => call[1]);
    expect(declared).toEqual(["rustup-home", "cargo-home"]);
});

test("rejects channel versions, requiring an exact pin", () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);
    let message = null;

    try {
        api.rustToolchain("stable", { default: true });
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("must be an exact version");
});

test("throws when no toolchain has been declared", async () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);
    let message = null;

    try {
        await api.acquireRustToolchain("1.79.0");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no rust toolchain declared");
});

test("throws when no version is given and no default is set", async () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);
    api.rustToolchain("1.79.0");
    let message = null;

    try {
        await api.rustBin();
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("no rust toolchain version specified");
});

test("installs and acquires a toolchain from the named caches", async () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);
    const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });

    const seeded = api.installRustToolchain("1.79.0", SEED);
    expect(seeded.rustupHome).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
    expect(seeded.cargoHome).toBe("/cache/cargo-home/1.79.0/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "rustup-home" && call[2] === key && call[3] === "/tmp/rustup"),
    ).toBe(true);
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "cargo-home" && call[2] === key && call[3] === "/tmp/cargo"),
    ).toBe(true);

    expect(await api.acquireRustToolchain("1.79.0")).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
    expect(await api.rustBin("1.79.0")).toBe(
        "/cache/rustup-home/1.79.0/linux-x86_64/toolchains/1.79.0-x86_64-unknown-linux-gnu/bin/cargo",
    );
    // Already cached, so no download/install run() should have happened.
    expect(host.runs.length).toBe(0);
});

test("describes the two-cache tool with RUSTUP_HOME/CARGO_HOME mount paths", async () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);

    api.installRustToolchain("1.79.0", SEED);
    api.rustToolchain("1.79.0", { default: true });
    const tool = await api.rustTool();

    expect(tool.tools.length).toBe(2);
    const [rustup, cargo] = tool.tools;
    expect(rustup.cache).toBe("rustup-home");
    expect(rustup.binDirs).toEqual(["toolchains/1.79.0-x86_64-unknown-linux-gnu/bin"]);
    expect(cargo.cache).toBe("cargo-home");
    expect(cargo.binDirs).toEqual([]);
    expect(tool.rustupHome).toBe(".imp/tools/rustup-home");
    expect(tool.cargoHome).toBe(".imp/tools/cargo-home");
    expect(tool.toolchainId).toBe("1.79.0-x86_64-unknown-linux-gnu");
});

test("downloads rustup-init and installs into both caches via sandboxed runs", async () => {
    const host = fakeHost();
    const api = createRustToolchainApi(host);
    const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });

    api.rustToolchain("1.79.0", { default: true });
    const path = await api.acquireRustToolchain("1.79.0");

    expect(path).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
    expect(host.runs.length).toBe(2);

    const [download, install] = host.runs;
    expect(download.argv[0]).toBe("sh");
    expect(download.argv.some((arg) => arg.includes("x86_64-unknown-linux-gnu/rustup-init"))).toBe(true);
    expect(download.tools[0].name).toBe("curl");

    // The install run wires RUSTUP_HOME/CARGO_HOME from $PWD in-script and pins
    // the toolchain, then commits both directories to their caches.
    const script = install.argv[2];
    expect(script).toContain('RUSTUP_HOME="$PWD/$2"');
    expect(script).toContain('CARGO_HOME="$PWD/$3"');
    expect(script).toContain("--default-toolchain");
    expect(install.argv).toContain("1.79.0");
    const outCaches = install.outputs.map((out) => `${out.namedCache.name}/${out.namedCache.key}`);
    expect(outCaches).toEqual([`rustup-home/${key}`, `cargo-home/${key}`]);
});

test("uses the windows target triple and installer name", () => {
    const host = fakeHost({ os: "windows", arch: "x86_64" });
    const api = createRustToolchainApi(host);
    api.rustToolchain("1.79.0", { default: true });
    // sh is declared as a core tool on windows (bare sh doesn't auto-resolve).
    expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "sh")).toBe(true);
});
});
