import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    ociBuild,
    ociBuildBuild,
    ociMirror,
    ociMirrorBuild,
    ociPull,
    ociPullBuild,
    ociPush,
    ociPushBuild,
} from "//rules/oci";
import { __resetCraneToolchainStateForTest, craneToolchain, installCraneToolchain } from "//rules/oci/toolchain";
import { __resetOciStorageStateForTest } from "//rules/oci/storage";

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

// Wraps withFakeToolchainHost's __host_run so a test can control what
// specific crane invocations "print" to stdout (e.g. `crane digest`'s
// resolved digest) while still recording every call into host.runs.
function withCraneStdout(stdoutByNeedle, fn) {
    return async (host) => {
        const real = globalThis.__host_run;
        globalThis.__host_run = async (opts) => {
            const result = await real(opts);
            const argvStr = (opts.argv || []).join(" ");
            for (const [needle, stdout] of stdoutByNeedle) {
                if (argvStr.includes(needle)) return { ...result, stdout };
            }
            return result;
        };
        try {
            return await fn(host);
        } finally {
            globalThis.__host_run = real;
        }
    };
}

function withOciHost(fn) {
    return withFakeToolchainHost(async (host) => {
        __resetCraneToolchainStateForTest();
        __resetOciStorageStateForTest();
        craneToolchain("0.20.6", { default: true });
        installCraneToolchain("0.20.6", "/tmp/crane-0.20.6");
        try {
            return await fn(host);
        } finally {
            __resetCraneToolchainStateForTest();
            __resetOciStorageStateForTest();
        }
    });
}

describe("oci rules", () => {

test("ociPull requires repo", () => {
    expect(() => ociPull({ tag: "latest" })).toThrow("requires 'repo'");
});

test("ociPull requires exactly one of tag/digest", () => {
    expect(() => ociPull({ repo: "alpine" })).toThrow("exactly one of 'tag' or 'digest'");
    expect(() => ociPull({ repo: "alpine", tag: "latest", digest: DIGEST_A })).toThrow("exactly one of 'tag' or 'digest'");
});

test("ociPull by tag resolves a digest (impure) then pulls it (cacheable)", async () => {
    await withOciHost(withCraneStdout([["crane digest", DIGEST_A]], async (host) => {
        const target = ociPull({ repo: "docker.io/library/alpine", tag: "3.20" });
        const result = await ociPullBuild(target);

        expect(result.digest).toBe(DIGEST_A);
        expect(host.runs.length).toBe(2);

        const [digestRun, pullRun] = host.runs;
        expect(digestRun.argv).toEqual(["crane", "digest", "docker.io/library/alpine:3.20"]);
        expect(digestRun.impure).toBe(true);

        expect(pullRun.argv[0]).toBe("crane");
        expect(pullRun.argv[1]).toBe("pull");
        expect(pullRun.argv).toContain("docker.io/library/alpine@" + DIGEST_A);
        expect(pullRun.impure).toBeFalsy();
        expect(pullRun.outputs[0].namedCache.name).toBe("oci-storage");
    }));
});

test("ociPull by digest skips the resolve step entirely", async () => {
    await withOciHost(async (host) => {
        const target = ociPull({ repo: "docker.io/library/alpine", digest: DIGEST_A });
        const result = await ociPullBuild(target);

        expect(result.digest).toBe(DIGEST_A);
        expect(host.runs.length).toBe(1);
        expect(host.runs[0].argv[1]).toBe("pull");
    });
});

test("ociPull short-circuits when the digest is already cached", async () => {
    await withOciHost(async (host) => {
        host.install("oci-storage", "sha256/" + "a".repeat(64), "/cache/oci-storage/sha256/" + "a".repeat(64));
        const target = ociPull({ repo: "docker.io/library/alpine", digest: DIGEST_A });
        const result = await ociPullBuild(target);

        expect(result.ociLayoutPath).toBe("/cache/oci-storage/sha256/" + "a".repeat(64));
        expect(host.runs.length).toBe(0);
    });
});

test("ociBuild requires a valid base", () => {
    expect(() => ociBuild({ base: null, layers: [{ srcs: ["*"], path: "/app" }] }))
        .toThrow("must be an ociPull()/ociBuild() target handle");
});

test("ociBuild requires at least one layer", () => {
    expect(() => ociBuild({ base: "scratch", layers: [] })).toThrow("requires one or more 'layers'");
});

test("ociBuild stages deterministic layer tarballs and composes onto its base", async () => {
    await withOciHost(withCraneStdout([["oci-compose", DIGEST_B]], async (host) => {
        const base = ociPull({ repo: "docker.io/library/alpine", digest: DIGEST_A });
        const target = ociBuild({
            base,
            layers: [{ srcs: ["rules/oci/toolchain.js"], path: "/app" }],
        });
        const result = await ociBuildBuild(target);

        expect(result.digest).toBe(DIGEST_B);
        // pull (base) + stage-layer-tar + compose; no crane involved in
        // composing the layout itself.
        expect(host.runs.length).toBe(3);

        const stageRun = host.runs[1];
        expect(stageRun.argv[0]).toBe("sh");
        expect(stageRun.argv.some((arg) => typeof arg === "string" && arg.includes('--mtime="@0"'))).toBe(true);
        expect(stageRun.argv.some((arg) => typeof arg === "string" && arg.includes("--numeric-owner"))).toBe(true);
        expect(stageRun.argv).toContain("rules/oci/toolchain.js");

        const composeRun = host.runs[2];
        expect(composeRun.argv[0]).toBe("sh");
        expect(composeRun.argv[3]).toBe("oci-compose");
        // base is an ociPull() result — lives in the oci-storage named cache
        // outside the workspace, so it's mounted via the tools: idiom rather
        // than a plain {kind:"directory"} input.
        expect(composeRun.tools.some((t) => t.name === "oci-base")).toBe(true);
    }));
});

test("ociBuild from scratch composes directly with config attrs baked into the layout", async () => {
    await withOciHost(withCraneStdout([["oci-compose", DIGEST_B]], async (host) => {
        const target = ociBuild({
            base: "scratch",
            layers: [{ srcs: ["rules/oci/toolchain.js"], path: "/app" }],
            entrypoint: ["/app/run"],
            env: { FOO: "bar" },
        });
        const result = await ociBuildBuild(target);

        expect(result.digest).toBe(DIGEST_B);
        // stage-layer-tar + compose; no base to pull, no crane at all.
        expect(host.runs.length).toBe(2);

        const composeRun = host.runs[1];
        expect(composeRun.argv[3]).toBe("oci-compose");
        expect(composeRun.argv).toContain(JSON.stringify(["/app/run"]));
        expect(composeRun.argv).toContain(JSON.stringify(["FOO=bar"]));
        expect(composeRun.tools.some((t) => t.name === "oci-base")).toBe(false);
    }));
});

test("ociPush requires image/repo/tag", () => {
    expect(() => ociPush({ repo: "ghcr.io/org/app", tag: "v1" })).toThrow("requires 'image'");
    expect(() => ociPush({ image: ociPull({ repo: "alpine", tag: "latest" }), tag: "v1" })).toThrow("requires 'repo'");
    expect(() => ociPush({ image: ociPull({ repo: "alpine", tag: "latest" }), repo: "ghcr.io/org/app" })).toThrow("requires 'tag'");
});

test("ociPush resolves its image's build product and pushes impurely", async () => {
    await withOciHost(async (host) => {
        host.install("oci-storage", "sha256/" + "a".repeat(64), "/cache/oci-storage/sha256/" + "a".repeat(64));
        const image = ociPull({ repo: "docker.io/library/alpine", digest: DIGEST_A });
        const target = ociPush({ image, repo: "ghcr.io/org/app", tag: "v1" });
        await ociPushBuild(target);

        const pushRun = host.runs[host.runs.length - 1];
        // The pulled image lives in the oci-storage named cache outside the
        // workspace, so it's mounted via the same tools: idiom as oci-base
        // (mountOciLayout) rather than passed as a raw absolute path.
        expect(pushRun.argv).toEqual(["crane", "push", ".imp/tools/oci-push-image", "ghcr.io/org/app:v1"]);
        expect(pushRun.tools.some((t) => t.name === "oci-push-image")).toBe(true);
        expect(pushRun.impure).toBe(true);
    });
});

test("ociMirror requires from/to", () => {
    expect(() => ociMirror({ to: { repo: "ghcr.io/org/app", tag: "v1" } })).toThrow("requires 'from");
    expect(() => ociMirror({ from: { repo: "docker.io/library/alpine", tag: "3.20" } })).toThrow("requires 'to");
});

test("ociMirror copies directly between registries, impurely", async () => {
    await withOciHost(async (host) => {
        const target = ociMirror({
            from: { repo: "docker.io/library/alpine", tag: "3.20" },
            to: { repo: "ghcr.io/org/alpine", tag: "3.20" },
        });
        await ociMirrorBuild(target);

        expect(host.runs.length).toBe(1);
        expect(host.runs[0].argv).toEqual(["crane", "copy", "docker.io/library/alpine:3.20", "ghcr.io/org/alpine:3.20"]);
        expect(host.runs[0].impure).toBe(true);
    });
});
});
