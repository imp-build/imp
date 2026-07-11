import { describe, expect, test, withFakeDiff, withFakeToolchainHost } from "//rules/imp/test";
import { pythonApp } from "//rules/python";
import { ruffFmt, ruffFormatCheck } from "//rules/python/fmt";
import {
    __resetRuffToolchainStateForTest,
    ruffToolchain,
} from "//rules/python/ruff_toolchain";

function withRuffHost(fn) {
    const run = async (host) => {
        __resetRuffToolchainStateForTest();
        try {
            return await fn(host);
        } finally {
            __resetRuffToolchainStateForTest();
        }
    };
    return withFakeToolchainHost(run);
}

describe("python fmt", () => {

test("ruffFormatCheck runs ruff format --check against the target's sources", async () => {
    await withRuffHost(async (host) => {
        ruffToolchain("0.15.21", { default: true });
        const app = pythonApp({ src: "rules/python/example" });

        await ruffFormatCheck(app);

        const fmtRun = host.runs[host.runs.length - 1];
        expect(fmtRun.argv[0]).toBe("ruff");
        expect(fmtRun.argv).toContain("--check");
        expect(fmtRun.outputs).toEqual([]);
    });
});

test("ruffFmt runs ruff format without --check and declares source outputs", async () => {
    await withRuffHost(async (host) => {
        ruffToolchain("0.15.21", { default: true });
        const app = pythonApp({ src: "rules/python/example" });

        // withFakeRun-backed hosts don't produce a real outputDigest, so
        // diffDigests needs a stubbed result — same pattern as
        // rules/rust/fmt_test.js.
        await withFakeDiff([{ type: "modified", path: "rules/python/example/src/hello/__init__.py" }], async () => {
            const result = await ruffFmt(app);
            expect(result.formatted).toBe(1);
        });

        const fmtRun = host.runs[host.runs.length - 1];
        expect(fmtRun.argv).not.toContain("--check");
        expect(Array.isArray(fmtRun.outputs)).toBe(true);
    });
});

});
