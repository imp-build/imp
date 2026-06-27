import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    cmakeCacheKey,
    createCmakeToolchainApi,
} from "//rules/c/cmake/toolchain";

function fakeHost(plat = { os: "linux", arch: "x86_64" }) {
    const calls = [];
    const cache = new Map();

    return {
        calls,
        install(name, key, path) {
            cache.set(`${name}/${key}`, path);
        },
        namedCache(opts) {
            calls.push(["namedCache", opts.name]);
        },
        platformInfo() {
            calls.push(["platformInfo"]);
            return plat;
        },
        cacheHas(name, key) {
            calls.push(["cacheHas", name, key]);
            return cache.has(`${name}/${key}`);
        },
        cacheGet(name, key) {
            calls.push(["cacheGet", name, key]);
            return cache.get(`${name}/${key}`) || null;
        },
        cachePut(name, key, source) {
            calls.push(["cachePut", name, key, source]);
            cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
        },
    };
}

describe("CMake toolchain", () => {
test("declares a default CMake toolchain", () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    const key = api.cmakeToolchain("3.30.5", { default: true });

    expect(key).toBe("cmake-toolchains/3.30.5/linux-x86_64");
    expect(api.defaultCmakeToolchainVersion()).toBe("3.30.5");
    expect(host.calls[0][0]).toBe("namedCache");
});

test("uses system cmake without a declared toolchain", () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    expect(api.cmakeBin()).toBe("cmake");
});

test("installs and acquires a toolchain from the named cache", () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

    expect(
        api.installCmakeToolchain("3.30.5", "/tmp/cmake-3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64");
    expect(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "cmake-toolchains" && call[2] === key && call[3] === "/tmp/cmake-3.30.5"),
    ).toBe(true);

    expect(
        api.acquireCmakeToolchain("3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64");
    expect(
        api.cmakeBin("3.30.5"),
    ).toBe("/cache/cmake-toolchains/3.30.5/linux-x86_64/bin/cmake");
});

test("reports a missing toolchain", () => {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    let message = null;

    try {
        api.acquireCmakeToolchain("3.30.5");
    } catch (error) {
        message = error.message;
    }

    expect(message).toContain("CMake toolchain 3.30.5 is not installed");
});
});
