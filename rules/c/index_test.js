import {
    describe,
    expect,
    test,
    withFakeMergeDigests,
    withFakeToolchainHost,
} from "//rules/imp/test";
import { getMemoTrace } from "imp:core";
import {
    ccBuild,
    ccBinary,
    ccLibrary,
    has_c_main_entrypoint,
} from "//rules/c";
import {
    __resetGccToolchainStateForTest,
    gccToolchain,
    installGccToolchain,
} from "//rules/c/gcc/toolchain";

async function withGccHost(fn) {
    return withFakeToolchainHost(async (host) => {
        __resetGccToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetGccToolchainStateForTest();
        }
    });
}

describe("C/C++ rules", () => {

test("ccLibrary declares a generic cc_library target", () => {
    const lib = ccLibrary({ path: "rules/c/cmake/example", srcs: ["hello.c"] });

    expect(lib.kind).toBe("cc_library");
    expect(lib.attrs.backend).toBe("raw");
    expect(lib.attrs.path).toBe("rules/c/cmake/example");
});

test("ccBinary declares a generic cc_binary target", () => {
    const bin = ccBinary({ path: "rules/c/cmake/example", srcs: ["main.c"] });

    expect(bin.kind).toBe("cc_binary");
    expect(bin.attrs.backend).toBe("raw");
});

test("has_c_main_entrypoint ignores comments and strings", () => {
    const source = [
        "const char *s = \"int main(void)\";",
        "/* int main(void) { return 1; } */",
        "int helper(void) { return 0; }",
    ].join("\n");

    expect(has_c_main_entrypoint(source)).toBe(false);
});

test("has_c_main_entrypoint detects a real main declaration", () => {
    expect(has_c_main_entrypoint("int main(int argc, char **argv) { return argc; }\n")).toBe(true);
});

test("raw ccLibrary build compiles and archives with a declared C/C++ toolchain", async () => {
    await withGccHost(async (host) => {
        await withFakeMergeDigests(async () => {
            installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
            const gcc = gccToolchain("2025.08-1", { default: true, unverified: true });
            const lib = ccLibrary({ path: "rules/c/cmake/example", srcs: ["hello.c"], toolchain: gcc, output: "build/c/testlib.a" });

            const result = await ccBuild(lib);

            expect(result.outputPath).toBe("build/c/testlib.a");
            expect(host.runs.length).toBe(2);
            expect(host.runs[0].display).toContain("cc compile");
            expect(host.runs[1].display).toContain("cc archive");
            const { trace } = getMemoTrace();
            expect(trace.some(t => t.event === "effect" && t.kind === "run" && t.display.includes("cc compile"))).toBe(true);
        });
    });
});

});
