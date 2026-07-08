import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import { parseTestBinaries, rustTestBuild, rustTestRun, RustTest } from "//rules/rust/test";
import {
    __resetRustToolchainStateForTest,
    rustToolchain,
} from "//rules/rust/toolchain";
import { gccToolchain, __resetGccToolchainStateForTest } from "//rules/c/gcc/toolchain";

function withRustHost(fn) {
    const run = async (host) => {
        __resetRustToolchainStateForTest();
        __resetGccToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetRustToolchainStateForTest();
            __resetGccToolchainStateForTest();
        }
    };
    return withFakeToolchainHost(run);
}

describe("rust test fan-out", () => {

test("parseTestBinaries keeps only compiled test-profile artifacts and rebases their path onto buildDir", () => {
    const buildDir = "build/rust/root";
    const stdout = [
        JSON.stringify({
            reason: "compiler-artifact",
            target: { name: "hello", kind: ["bin"] },
            profile: { test: true },
            executable: `/sandbox/xyz/${buildDir}/debug/deps/hello-abc123`,
        }),
        // A non-test build artifact (e.g. the plain `cargo build` of the bin
        // itself) must be ignored even though it also has an `executable`.
        JSON.stringify({
            reason: "compiler-artifact",
            target: { name: "hello", kind: ["bin"] },
            profile: { test: false },
            executable: `/sandbox/xyz/${buildDir}/debug/hello`,
        }),
        // Non-artifact messages (build scripts, warnings) must be ignored.
        JSON.stringify({ reason: "compiler-message" }),
        "",
        JSON.stringify({
            reason: "compiler-artifact",
            target: { name: "integration", kind: ["test"] },
            profile: { test: true },
            executable: `/sandbox/xyz/${buildDir}/debug/deps/integration-def456`,
        }),
    ].join("\n");

    const binaries = parseTestBinaries(stdout, buildDir);

    expect(binaries.length).toBe(2);
    expect(binaries[0].name).toBe("hello");
    expect(binaries[0].kind).toBe("bin");
    expect(binaries[0].executable).toBe(`${buildDir}/debug/deps/hello-abc123`);
    expect(binaries[1].name).toBe("integration");
    expect(binaries[1].kind).toBe("test");
    expect(binaries[1].executable).toBe(`${buildDir}/debug/deps/integration-def456`);
});

test("parseTestBinaries tolerates malformed JSON lines", () => {
    const buildDir = "build/rust/root";
    const stdout = "not json\n" + JSON.stringify({
        reason: "compiler-artifact",
        target: { name: "hello", kind: ["bin"] },
        profile: { test: true },
        executable: `${buildDir}/debug/deps/hello-abc123`,
    });

    const binaries = parseTestBinaries(stdout, buildDir);
    expect(binaries.length).toBe(1);
});

test("rustTestBuild builds via `cargo test --no-run --message-format=json`", async () => {
    await withRustHost(async (host) => {
        gccToolchain("2025.08-1", { default: true });
        rustToolchain("1.93.0", { default: true });
        const rustTest = new RustTest({
            path: "rules/rust/example",
            buildDir: "build/rust/rules/rust/example",
            executable: "build/rust/rules/rust/example/debug/deps/hello-abc123",
        });

        await rustTestBuild(rustTest);

        const buildRun = host.runs[host.runs.length - 1];
        expect(buildRun.argv[0]).toBe("sh");
        expect(buildRun.argv[2]).toContain("--no-run");
        expect(buildRun.argv[2]).toContain("--message-format=json");
        expect(buildRun.argv).toContain("rules/rust/example/Cargo.toml");
    });
});

test("rustTestRun executes only the target's own binary, single-threaded", async () => {
    await withRustHost(async (host) => {
        gccToolchain("2025.08-1", { default: true });
        rustToolchain("1.93.0", { default: true });
        const rustTest = new RustTest({
            path: "rules/rust/example",
            buildDir: "build/rust/rules/rust/example",
            executable: "build/rust/rules/rust/example/debug/deps/hello-abc123",
            testArgs: ["--nocapture"],
        });

        await rustTestRun(rustTest);

        const testRun = host.runs[host.runs.length - 1];
        expect(testRun.argv[0]).toBe("build/rust/rules/rust/example/debug/deps/hello-abc123");
        expect(testRun.argv).toContain("--test-threads=1");
        expect(testRun.argv).toContain("--nocapture");
        expect(testRun.impure).toBe(true);
    });
});

});
