import { paths, pathsInDigest } from "imp:core";
import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    cargoBuild,
    cargoPackage,
    cargoTest,
    declared_path,
    resources,
} from "//rules/rust";
import { resourcePackage } from "//rules/asset";
import {
    __resetRustToolchainStateForTest,
    rustToolchain,
} from "//rules/rust/toolchain";
import {
    __resetGccToolchainStateForTest,
    gccToolchain,
} from "//rules/c/gcc/toolchain";
import {
    __resetMoldToolchainStateForTest,
    moldToolchain,
} from "//rules/c/mold/toolchain";

function withRustHost(platOrFn, maybeFn) {
    const run = async (host) => {
        __resetRustToolchainStateForTest();
        __resetGccToolchainStateForTest();
        __resetMoldToolchainStateForTest();
        const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
        try {
            return await fn(host);
        } finally {
            __resetRustToolchainStateForTest();
            __resetGccToolchainStateForTest();
            __resetMoldToolchainStateForTest();
        }
    };
    return typeof platOrFn === "function"
        ? withFakeToolchainHost(run)
        : withFakeToolchainHost(platOrFn, run);
}

describe("rust rules", () => {

test("cargoPackage requires a bin name", () => {
    expect(() => cargoPackage({})).toThrow("requires 'bin'");
});

test("cargoPackage accepts a single bin name or an array", () => {
    const single = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
    expect(single.attrs.bins).toEqual(["hello"]);

    const multi = cargoPackage({ bin: ["a", "b"], toolchain: "1.93.0" });
    expect(multi.attrs.bins).toEqual(["a", "b"]);
});

test("cargoPackage keeps explicit string versions free of toolchain target deps", () => {
    const pkg = cargoPackage({ bin: "hello", toolchain: "1.93.0" });
    expect(pkg.attrs.toolchainVersion).toBe("1.93.0");
    expect(pkg.attrs.toolchain).toBe(undefined);
});

test("cargoPackage uses the default Rust toolchain target when none is given", () => {
    return withRustHost(async () => {
        const toolchain = rustToolchain("1.93.0", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
        expect(pkg.attrs.toolchain).toBe(toolchain);
    });
});

test("cargoBuild throws without a declared gcc toolchain default", async () => {
    await withRustHost(async () => {
        rustToolchain("1.93.0", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        let message = null;
        try {
            await cargoBuild(pkg);
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("gccToolchain() default");
    });
});

test("cargoBuild invokes cargo with the manifest path, target dir, and toolchain env", async () => {
    await withRustHost(async (host) => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        const result = await cargoBuild(pkg);

        const path = declared_path(pkg, pkg.attrs.path);
        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.argv[0]).toBe("sh");
        expect(buildRun.argv).toContain(`${path}/Cargo.toml`);
        expect(buildRun.env).toContain("RUSTUP_HOME=.imp/tools/rustup-home");
        expect(buildRun.env).toContain("CARGO_HOME=.imp/tools/cargo-home");
        expect(buildRun.argv[2]).toContain("RUSTFLAGS=\"$rustflags\"");
        expect(buildRun.env).toContain("CC=clang");
        expect(buildRun.argv).toContain("-C linker=clang");
        expect(result.outputPaths.length).toBe(1);
        expect(result.outputPaths[0].endsWith("/debug/hello")).toBe(true);
    });
});

test("cargoBuild passes --release and uses the release output dir", async () => {
    await withRustHost(async (host) => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const pkg = cargoPackage({ bin: "hello", release: true, path: "rules/rust/example" });

        const result = await cargoBuild(pkg);

        expect(result.outputPaths[0].endsWith("/release/hello")).toBe(true);
        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.argv).toContain("--release");
    });
});
test("cargoBuild uses native gcc as the linker on windows", async () => {
    await withRustHost({ os: "windows", arch: "x86_64" }, async (host) => {
        rustToolchain("1.93.0", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        await cargoBuild(pkg);

        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.argv).toContain("-C linker=gcc");
        expect(host.calls.some((call) => call[0] === "nativeTool" && call[1] === "gcc")).toBe(true);
    });
});

test("cargoTest throws without a declared gcc toolchain default", async () => {
    await withRustHost(async () => {
        rustToolchain("1.93.0", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        let message = null;
        try {
            await cargoTest(pkg);
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain("gccToolchain() default");
    });
});

test("cargoTest invokes cargo test with the manifest path, target dir, and toolchain env", async () => {
    await withRustHost(async (host) => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        await cargoTest(pkg);

        const path = declared_path(pkg, pkg.attrs.path);
        const testRun = host.runs[host.runs.length - 1];
        expect(testRun.argv[0]).toBe("sh");
        expect(testRun.argv[2]).toContain("cargo test");
        expect(testRun.argv).toContain(`${path}/Cargo.toml`);
        expect(testRun.env).toContain("RUSTUP_HOME=.imp/tools/rustup-home");
        expect(testRun.env).toContain("CARGO_HOME=.imp/tools/cargo-home");
        expect(testRun.argv[2]).toContain("RUSTFLAGS=\"$rustflags\"");
        expect(testRun.env).toContain("CC=clang");
        expect(testRun.argv).toContain("-C linker=clang");
        expect(testRun.impure).toBe(true);
        expect(testRun.outputs).toEqual([]);
    });
});

test("cargoTest passes through extra testArgs", async () => {
    await withRustHost(async (host) => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example", testArgs: ["--", "--nocapture"] });

        await cargoTest(pkg);

        const testRun = host.runs[host.runs.length - 1];
        expect(testRun.argv).toContain("--nocapture");
    });
});

test("cargoBuild adds mold backend flags and tool when the toolchain configures a linker", async () => {
    await withRustHost(async (host) => {
        gccToolchain("2025.08-1", { default: true });
        const mold = moldToolchain("2.41.0");
        const toolchain = rustToolchain("1.93.0", { default: true, linker: mold });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
        expect(pkg.attrs.toolchain).toBe(toolchain);

        await cargoBuild(pkg);

        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.argv).toContain("-C linker=clang -C link-arg=-fuse-ld=mold");
        expect(buildRun.tools.some((t) => t.name === "mold")).toBe(true);
    });
});

test("cargoBuild honors an explicit non-default linkDriver over defaultGccToolchain()", async () => {
    await withRustHost(async (host) => {
        gccToolchain("2025.08-1", { default: true });
        const explicitGcc = gccToolchain("2024.02-1");
        rustToolchain("1.93.0", { default: true, linkDriver: explicitGcc });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });

        await cargoBuild(pkg);

        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.tools.some((t) => t.key && t.key.startsWith("2024.02-1/"))).toBe(true);
    });
});

test("cargoBuild builds one output path per bin", async () => {
    await withRustHost(async () => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const pkg = cargoPackage({ bin: ["hello", "world"], path: "rules/rust/example" });

        const result = await cargoBuild(pkg);

        expect(result.outputPaths.length).toBe(2);
        expect(result.outputPaths[0].endsWith("/debug/hello")).toBe(true);
        expect(result.outputPaths[1].endsWith("/debug/world")).toBe(true);
    });
});

test("resources(pkg) is empty without a resource-package dep", async () => {
    const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example" });
    expect(paths(await resources(pkg))).toEqual([]);
});

test("resources(pkg) with a resource-package dep includes its files", async () => {
    const assets = resourcePackage({ path: "rules/rust", srcs: ["toolchain.js"] });
    const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example", deps: [assets] });
    const result = paths(await resources(pkg));
    expect(result).toContain("rules/rust/toolchain.js");
});

test("cargoBuild declares resource-package files as sandbox inputs", async () => {
    await withRustHost(async (host) => {
        rustToolchain("1.93.0", { default: true });
        gccToolchain("2025.08-1", { default: true });
        const assets = resourcePackage({ path: "rules/rust", srcs: ["toolchain.js"] });
        const pkg = cargoPackage({ bin: "hello", path: "rules/rust/example", deps: [assets] });

        await cargoBuild(pkg);

        const buildRun = host.runs[host.runs.length - 1];
        // Glob-derived inputs are collapsed into a single {kind:"digest"}
        // entry per merged glob rather than one {kind:"file", path} entry
        // per match (see rules/odin/index_test.js's inputsIncludePath), so
        // "was this path fed into the sandbox" has to walk the digest.
        const includesPath = buildRun.inputs.some((input) =>
            input.kind === "digest" && pathsInDigest(input.digest).includes("rules/rust/toolchain.js"));
        expect(includesPath).toBe(true);
    });
});

});
