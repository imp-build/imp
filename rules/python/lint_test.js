import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import { pythonApp } from "//rules/python";
import { ruffCheck } from "//rules/python/lint";
import {
    __resetRuffToolchainStateForTest,
    ruffToolchain,
} from "//rules/python/ruff_toolchain";

function withRuffHost(fn) {
    const run = async (host) => {
        __resetRuffToolchainStateForTest();
        // Cold acquires verify against the lockfile, so the fake host needs
        // a matching entry for the toolchain the tests declare.
        host.addFile("//rules/python/ruff-toolchain.lock", JSON.stringify({
            tool: "ruff-toolchain",
            version: "0.15.21",
            artifacts: {
                "linux/x86_64": {
                    url: "https://locked.example/ruff.tar.gz",
                    artifact: "ruff.tar.gz",
                    sha256: "deadbeef",
                },
            },
        }));
        try {
            return await fn(host);
        } finally {
            __resetRuffToolchainStateForTest();
        }
    };
    return withFakeToolchainHost(run);
}

describe("python lint", () => {

test("ruffCheck runs ruff check against the target's sources", async () => {
    await withRuffHost(async (host) => {
        ruffToolchain("0.15.21", { default: true });
        const app = pythonApp({ src: "rules/python/example" });

        const result = await ruffCheck(app);

        expect(result.ok).toBe(true);
        const checkRun = host.runs[host.runs.length - 1];
        expect(checkRun.argv[0]).toBe("ruff");
        expect(checkRun.argv).toContain("check");
        expect(checkRun.allowFailure).toBe(true);
    });
});

test("ruffCheck reports a nonzero exit as ok:false instead of throwing", async () => {
    await withRuffHost(async (host) => {
        ruffToolchain("0.15.21", { default: true });
        const app = pythonApp({ src: "rules/python/example" });

        const originalRun = globalThis.__host_run;
        globalThis.__host_run = async (opts) => {
            host.runs.push(opts);
            return { stdout: "E501 line too long\n", stderr: "", exitCode: 1 };
        };
        try {
            const result = await ruffCheck(app);
            expect(result.ok).toBe(false);
            expect(result.output).toContain("line too long");
        } finally {
            globalThis.__host_run = originalRun;
        }
    });
});

});
