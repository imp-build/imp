import { describe, expect, test } from "//rules/imp/test";
import { generateToolLockfile } from "//rules/workflows/lockfiles";
import { odinSupportedPlatforms } from "//rules/odin/toolchain";
import { cmakeSupportedPlatforms } from "//rules/c/cmake/toolchain";
import { gccSupportedPlatforms } from "//rules/c/gcc/toolchain";
import { moldSupportedPlatforms } from "//rules/c/mold/toolchain";
import { zigSupportedPlatforms } from "//rules/c/zig/toolchain";
import { zolaSupportedPlatforms } from "//rules/zola/toolchain";
import { rustSupportedPlatforms } from "//rules/rust/toolchain";

// Records every download/sha256 and captures the run() that writes the lockfile,
// so a lockfile can be generated without touching the network or the sandbox.
function fakeHost() {
    const writes = [];
    return {
        writes,
        download(url) {
            return `/dl/${url}`;
        },
        sha256(path) {
            return `sha256:${path}`;
        },
        output(path) {
            return { __output: path };
        },
        output_path(path) {
            return `/ws/${path}`;
        },
        run(opts) {
            writes.push(opts);
            return Promise.resolve({});
        },
    };
}

describe("generateToolLockfile", () => {

test("pins version + per-platform url/artifact/sha256", async () => {
    const host = fakeHost();
    const handle = { attrs: { version: "1.2.3" } };
    const platforms = [
        { os: "linux", arch: "x86_64" },
        { os: "macos", arch: "aarch64" },
    ];
    const downloadUrl = (v, p) => `https://ex/${v}/${p.os}-${p.arch}`;
    const artifactName = (v, p) => `tool-${v}-${p.os}-${p.arch}.tar`;

    const lock = await generateToolLockfile(
        { handle, name: "tool", platforms, downloadUrl, artifactName },
        host,
    );

    expect(lock).toEqual({
        tool: "tool",
        version: "1.2.3",
        artifacts: {
            "linux/x86_64": {
                url: "https://ex/1.2.3/linux-x86_64",
                artifact: "tool-1.2.3-linux-x86_64.tar",
                sha256: "sha256:/dl/https://ex/1.2.3/linux-x86_64",
            },
            "macos/aarch64": {
                url: "https://ex/1.2.3/macos-aarch64",
                artifact: "tool-1.2.3-macos-aarch64.tar",
                sha256: "sha256:/dl/https://ex/1.2.3/macos-aarch64",
            },
        },
    });
});

test("writes <name>.lock as a cacheable run() with the lock as content", async () => {
    const host = fakeHost();
    const handle = { attrs: { version: "9" } };
    const lock = await generateToolLockfile(
        {
            handle,
            name: "widget",
            platforms: [{ os: "linux", arch: "x86_64" }],
            downloadUrl: () => "https://ex/a",
            artifactName: () => "a.tar",
        },
        host,
    );

    expect(host.writes.length).toBe(1);
    const write = host.writes[0];
    expect(write.display).toBe("write widget.lock");
    expect(write.outputs).toEqual([{ __output: "widget.lock" }]);
    // The JSON content rides in the final positional argv slot.
    expect(JSON.parse(write.argv[write.argv.length - 1])).toEqual(lock);
});

});

describe("toolchain supported-platform matrices", () => {

test("odin: linux/macos x86_64+aarch64, windows x86_64 only", () => {
    expect(odinSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
        { os: "macos", arch: "x86_64" },
        { os: "macos", arch: "aarch64" },
        { os: "windows", arch: "x86_64" },
    ]);
});

test("cmake: linux + windows, x86_64+aarch64 (no macos)", () => {
    expect(cmakeSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
        { os: "windows", arch: "x86_64" },
        { os: "windows", arch: "aarch64" },
    ]);
});

test("gcc: linux x86_64 only", () => {
    expect(gccSupportedPlatforms()).toEqual([{ os: "linux", arch: "x86_64" }]);
});

test("mold: linux x86_64+aarch64", () => {
    expect(moldSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
    ]);
});

test("zig: linux + windows, x86_64+aarch64", () => {
    expect(zigSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
        { os: "windows", arch: "x86_64" },
        { os: "windows", arch: "aarch64" },
    ]);
});

test("zola: linux/macos x86_64+aarch64, windows x86_64", () => {
    expect(zolaSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
        { os: "macos", arch: "x86_64" },
        { os: "macos", arch: "aarch64" },
        { os: "windows", arch: "x86_64" },
    ]);
});

test("rust: linux/macos x86_64+aarch64, windows x86_64", () => {
    expect(rustSupportedPlatforms()).toEqual([
        { os: "linux", arch: "x86_64" },
        { os: "linux", arch: "aarch64" },
        { os: "macos", arch: "x86_64" },
        { os: "macos", arch: "aarch64" },
        { os: "windows", arch: "x86_64" },
    ]);
});

});
