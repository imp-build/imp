import { productFor } from "imp:core";
import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetMoldToolchainStateForTest,
    acquireMoldToolchain,
    defaultMoldToolchain,
    defaultMoldToolchainVersion,
    installMoldToolchain,
    moldBin,
    moldCacheKey,
    moldTool,
    moldToolchain,
} from "//rules/c/mold/toolchain";

function withMoldHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetMoldToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetMoldToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("mold toolchain", () => {
test("declares a default mold toolchain", () => {
    return withMoldHost((host) => {
        const toolchain = moldToolchain("2.41.0", { default: true });

        expect(toolchain.__imp).toBe(true);
        expect(toolchain.attrs.version).toBe("2.41.0");
        expect(moldCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" })).toBe("2.41.0/linux-x86_64");
        expect(defaultMoldToolchainVersion()).toBe("2.41.0");
        expect(defaultMoldToolchain()).toBe(toolchain);
        expect(host.calls[0][0]).toBe("namedCache");
    });
});

test("throws when no toolchain has been declared", async () => {
    await withMoldHost(async () => {
        let message = null;

        try {
            await acquireMoldToolchain("2.41.0");
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no mold toolchain declared");
    });
});

test("throws when no version is given and no default is set", async () => {
    await withMoldHost(async () => {
        moldToolchain("2.41.0");
        let message = null;

        try {
            await moldBin();
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("no mold toolchain version specified");
    });
});

test("installs and acquires a toolchain from the named cache", async () => {
    await withMoldHost(async (host) => {
        const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });

        expect(
            installMoldToolchain("2.41.0", "/tmp/mold-2.41.0"),
        ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "mold-toolchains" && call[2] === key && call[3] === "/tmp/mold-2.41.0"),
        ).toBe(true);

        expect(
            await acquireMoldToolchain("2.41.0"),
        ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
        expect(
            await moldBin("2.41.0"),
        ).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64/bin/mold");
        // Already cached, so no download/extract run() should have happened.
        expect(host.runs.length).toBe(0);
    });
});

test("describes the named-cache-backed mold tool", async () => {
    await withMoldHost(async () => {
        installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
        moldToolchain("2.41.0", { default: true });
        const tool = await moldTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("mold");
        expect(tool.cache).toBe("mold-toolchains");
        expect(tool.key).toBe("2.41.0/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe("bin");
    });
});

test("installs a toolchain via a single sandboxed curl|tar run()", async () => {
    await withMoldHost(async (host) => {
        const key = moldCacheKey("2.41.0", { os: "linux", arch: "x86_64" });

        moldToolchain("2.41.0", { default: true });
        const path = await acquireMoldToolchain("2.41.0");

        expect(path).toBe("/cache/mold-toolchains/2.41.0/linux-x86_64");
        expect(host.runs.length).toBe(1);

        const [install] = host.runs;
        expect(install.argv[0]).toBe("sh");
        expect(install.argv.some((arg) => arg.includes("mold-2.41.0-x86_64-linux.tar.gz"))).toBe(true);
        expect(install.tools[0].name).toBe("curl");
        expect(install.tools.some((t) => t.name === "gzip")).toBe(true);
        expect(install.outputs[0].namedCache.name).toBe("mold-toolchains");
        expect(install.outputs[0].namedCache.key).toBe(key);

        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "curl")).toBe(true);
    });
});

test("registers an odin-linker product exposing -linker:mold and a mold tool", async () => {
    await withMoldHost(async () => {
        installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
        const toolchain = moldToolchain("2.41.0");

        const linker = await productFor(toolchain, "odin-linker");

        expect(await linker.flags()).toEqual(["-linker:mold"]);
        const tools = await linker.tools();
        expect(tools.length).toBe(1);
        expect(tools[0].name).toBe("mold");
    });
});

test("registers a rust-linker product exposing -fuse-ld=mold and a mold tool", async () => {
    await withMoldHost(async () => {
        installMoldToolchain("2.41.0", "/tmp/mold-2.41.0");
        const toolchain = moldToolchain("2.41.0");

        const linker = await productFor(toolchain, "rust-linker");

        expect(await linker.rustflags()).toEqual(["-C", "link-arg=-fuse-ld=mold"]);
        const tools = await linker.tools();
        expect(tools.length).toBe(1);
        expect(tools[0].name).toBe("mold");
    });
});
});
