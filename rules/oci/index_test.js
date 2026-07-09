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

test("ociBuild stages deterministic layer tarballs and appends onto its base", async () => {
    await withOciHost(withCraneStdout([["crane digest", DIGEST_B]], async (host) => {
        const base = ociPull({ repo: "docker.io/library/alpine", digest: DIGEST_A });
        const target = ociBuild({
            base,
            layers: [{ srcs: ["rules/oci/toolchain.js"], path: "/app" }],
        });
        const result = await ociBuildBuild(target);

        expect(result.digest).toBe(DIGEST_B);
        // pull (base) + stage-layer-tar + crane-append + crane-digest; no
        // crane-mutate since no config attrs were given.
        expect(host.runs.length).toBe(4);

        const stageRun = host.runs[1];
        expect(stageRun.argv[0]).toBe("sh");
        expect(stageRun.argv.some((arg) => typeof arg === "string" && arg.includes('--mtime="@0"'))).toBe(true);
        expect(stageRun.argv.some((arg) => typeof arg === "string" && arg.includes("--numeric-owner"))).toBe(true);
        expect(stageRun.argv).toContain("rules/oci/toolchain.js");

        const appendRun = host.runs[2];
        expect(appendRun.argv[0]).toBe("crane");
        expect(appendRun.argv[1]).toBe("append");
        expect(appendRun.argv).toContain("-f");
        expect(appendRun.argv).toContain("--new_layer");

        const digestRun = host.runs[3];
        expect(digestRun.argv[0]).toBe("crane");
        expect(digestRun.argv[1]).toBe("digest");
    }));
});

test("ociBuild from scratch omits -f and applies crane mutate when config attrs are given", async () => {
    await withOciHost(withCraneStdout([["crane digest", DIGEST_B]], async (host) => {
        const target = ociBuild({
            base: "scratch",
            layers: [{ srcs: ["rules/oci/toolchain.js"], path: "/app" }],
            entrypoint: ["/app/run"],
            env: { FOO: "bar" },
        });
        await ociBuildBuild(target);

        // stage-layer-tar + crane-append + crane-mutate + crane-digest.
        expect(host.runs.length).toBe(4);

        const appendRun = host.runs[1];
        expect(appendRun.argv).toContain("append");
        expect(appendRun.argv).not.toContain("-f");

        const mutateRun = host.runs[2];
        expect(mutateRun.argv[0]).toBe("crane");
        expect(mutateRun.argv[1]).toBe("mutate");
        expect(mutateRun.argv).toContain("--entrypoint");
        expect(mutateRun.argv).toContain("/app/run");
        expect(mutateRun.argv).toContain("--env");
        expect(mutateRun.argv).toContain("FOO=bar");
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
        expect(pushRun.argv).toEqual(["crane", "push", "/cache/oci-storage/sha256/" + "a".repeat(64), "ghcr.io/org/app:v1"]);
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
