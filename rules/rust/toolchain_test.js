import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetRustToolchainStateForTest,
    acquireRustToolchain,
    defaultRustToolchain,
    defaultRustToolchainVersion,
    installRustToolchain,
    rustBin,
    rustCacheKey,
    rustTool,
    rustToolchain,
} from "//rules/rust/toolchain";

function withRustHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetRustToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetRustToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

const SEED = { rustupHome: "/tmp/rustup", cargoHome: "/tmp/cargo" };

describe("rust toolchain", () => {
test("declares a default rust toolchain and both caches", () => {
    return withRustHost((host) => {
        const toolchain = rustToolchain("1.79.0", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("1.79.0");
        expect(rustCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("1.79.0/linux-x86_64");
        expect(defaultRustToolchainVersion()).toBe("1.79.0");
        expect(defaultRustToolchain()).toBe(toolchain);
        // Both RUSTUP_HOME and CARGO_HOME caches are declared up front.
        const declared = host.calls.filter((call) => call[0] === "namedCache").map((call) => call[1]);
        expect(declared).toEqual(["rustup-home", "cargo-home"]);
    });
});

test("rejects channel versions, requiring an exact pin", () => {
    return withRustHost(() => {
        let message = null;

        try {
            rustToolchain("stable", { default: true });
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("must be an exact version");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withRustHost(async () => {
        let message = null;

        try {
            await acquireRustToolchain("1.79.0");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no rust toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withRustHost(async () => {
        rustToolchain("1.79.0");
        let message = null;

        try {
            await rustBin();
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no rust toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named caches", async () => {
    await withRustHost(async (host) => {
        const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });

        const seeded = installRustToolchain("1.79.0", SEED);
        expect(seeded.rustupHome).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
        expect(seeded.cargoHome).toBe("/cache/cargo-home/1.79.0/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "rustup-home" && call[2] === key && call[3] === "/tmp/rustup"),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "cargo-home" && call[2] === key && call[3] === "/tmp/cargo"),
        ).toBe(true);

        expect(await acquireRustToolchain("1.79.0")).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
        expect(await rustBin("1.79.0")).toBe(
            "/cache/rustup-home/1.79.0/linux-x86_64/toolchains/1.79.0-x86_64-unknown-linux-gnu/bin/cargo",
        );
        // Already cached, so no download/install run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("describes the two-cache tool with RUSTUP_HOME/CARGO_HOME mount paths", async () => {
    await withRustHost(async () => {
        installRustToolchain("1.79.0", SEED);
        rustToolchain("1.79.0", { default: true });
        const tool = await rustTool();

        expect(tool.tools.length).toBe(2);
        const [rustup, cargo] = tool.tools;
        expect(rustup.cache).toBe("rustup-home");
        expect(rustup.binDirs).toEqual(["toolchains/1.79.0-x86_64-unknown-linux-gnu/bin"]);
        expect(cargo.cache).toBe("cargo-home");
        expect(cargo.binDirs).toEqual(["bin"]);
        expect(tool.rustupHome).toBe(".imp/tools/rustup-home");
        expect(tool.cargoHome).toBe(".imp/tools/cargo-home");
        expect(tool.rustupHomeAbs).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
        expect(tool.cargoHomeAbs).toBe("/cache/cargo-home/1.79.0/linux-x86_64");
        expect(tool.toolchainId).toBe("1.79.0-x86_64-unknown-linux-gnu");
    });
});

test("downloads rustup-init and installs into both caches via sandboxed runs", async () => {
    await withRustHost(async (host) => {
        const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });

        rustToolchain("1.79.0", { default: true });
        const path = await acquireRustToolchain("1.79.0");

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
});

test("uses the windows target triple and installer name", () => {
    return withRustHost({ os: "windows", arch: "x86_64" }, (host) => {
        rustToolchain("1.79.0", { default: true });
        // sh is declared as a core tool on windows (bare sh doesn't auto-resolve).
        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "sh")).toBe(true);
    });
});
});
