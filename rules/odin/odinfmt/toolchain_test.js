import {
    describe,
    expect,
    test,
    withFakeToolchainHost,
} from "//rules/imp/test";
import {
    __resetOdinToolchainStateForTest,
    odinToolchain,
} from "//rules/odin/toolchain";
import {
    acquireOdinfmt,
    odinfmtBin,
    odinfmtTool,
    olsTriple,
} from "//rules/odin/odinfmt/toolchain";

function withOdinHost(platOrFn, maybeFn) {
    const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
    const run = async (host) => {
        __resetOdinToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetOdinToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("odinfmt toolchain", () => {

test("uses the default Odin version for odinfmt binary lookup", () => {
    return withOdinHost(() => {
        odinToolchain("dev-2026-03", { default: true });

        expect(odinfmtBin()).toBe(
            "/cache/odinfmt-toolchains/dev-2026-03/linux-x86_64/odinfmt-x86_64-unknown-linux-gnu",
        );
    });
});

test("maps platforms to OLS release triples", () => {
    expect(olsTriple({ os: "linux", arch: "x86_64" })).toBe("x86_64-unknown-linux-gnu");
    expect(olsTriple({ os: "linux", arch: "aarch64" })).toBe("arm64-unknown-linux-gnu");
    expect(olsTriple({ os: "macos", arch: "aarch64" })).toBe("arm64-darwin");
    expect(olsTriple({ os: "windows", arch: "x86_64" })).toBe("x86_64-pc-windows-msvc");
    expect(() => olsTriple({ os: "freebsd", arch: "x86_64" })).toThrow();
});

test("installs a missing odinfmt from the OLS release zip", () => {
    return withOdinHost((host) => {
        const dir = acquireOdinfmt("dev-2026-03");

        expect(dir).toBe("/cache/odinfmt-toolchains/dev-2026-03/linux-x86_64");
        expect(
            host.calls.some((call) => call[0] === "namedCache" && call[1] === "odinfmt-toolchains"),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "download"
                && call[1] === "https://github.com/DanielGavin/ols/releases/download/dev-2026-03/ols-x86_64-unknown-linux-gnu.zip"),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "extract" && call[3] === "zip"),
        ).toBe(true);
        expect(
            host.calls.some((call) => call[0] === "cachePut" && call[1] === "odinfmt-toolchains"),
        ).toBe(true);
    });
});

test("describes the named-cache-backed odinfmt tool", () => {
    return withOdinHost(() => {
        odinToolchain("dev-2026-03", { default: true });
        const { tool, command } = odinfmtTool();

        expect(tool.kind).toBe("tool");
        expect(tool.name).toBe("odinfmt");
        expect(tool.cache).toBe("odinfmt-toolchains");
        expect(tool.key).toBe("dev-2026-03/linux-x86_64");
        expect(tool.binDirs.join(",")).toBe(".");
        expect(command).toBe("odinfmt-x86_64-unknown-linux-gnu");
    });
});

test("suffixes the odinfmt command with .exe on windows", () => {
    return withOdinHost({ os: "windows", arch: "x86_64" }, () => {
        odinToolchain("dev-2026-03", { default: true });

        expect(odinfmtTool().command).toBe("odinfmt-x86_64-pc-windows-msvc.exe");
    });
});

});
