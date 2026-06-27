import {
    cmakeCacheKey,
    createCmakeToolchainApi,
} from "//rules/c/cmake/toolchain";

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: got ${actual}, expected ${expected}`);
    }
}

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

function testToolchainDeclaration() {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    const key = api.cmakeToolchain("3.30.5", { default: true });

    assertEqual(key, "cmake-toolchains/3.30.5/linux-x86_64", "declared cache key");
    assertEqual(api.defaultCmakeToolchainVersion(), "3.30.5", "default version");
    assertEqual(host.calls[0][0], "namedCache", "declares named cache first");
}

function testSystemCmakeIsDefaultWithoutToolchain() {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);

    assertEqual(api.cmakeBin(), "cmake", "system cmake binary");
}

function testInstallAndAcquireToolchain() {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    const key = cmakeCacheKey("3.30.5", { os: "linux", arch: "x86_64" });

    assertEqual(
        api.installCmakeToolchain("3.30.5", "/tmp/cmake-3.30.5"),
        "/cache/cmake-toolchains/3.30.5/linux-x86_64",
        "installed toolchain dir",
    );
    assert(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "cmake-toolchains" && call[2] === key && call[3] === "/tmp/cmake-3.30.5"),
        "stores local CMake toolchain in named cache",
    );

    assertEqual(
        api.acquireCmakeToolchain("3.30.5"),
        "/cache/cmake-toolchains/3.30.5/linux-x86_64",
        "installed toolchain dir",
    );
    assertEqual(
        api.cmakeBin("3.30.5"),
        "/cache/cmake-toolchains/3.30.5/linux-x86_64/bin/cmake",
        "installed cmake binary",
    );
}

function testAcquireReportsMissingToolchain() {
    const host = fakeHost();
    const api = createCmakeToolchainApi(host);
    let message = null;

    try {
        api.acquireCmakeToolchain("3.30.5");
    } catch (error) {
        message = error.message;
    }

    assert(message && message.includes("CMake toolchain 3.30.5 is not installed"), "missing toolchain error");
}

export function runCmakeToolchainTests() {
    testToolchainDeclaration();
    testSystemCmakeIsDefaultWithoutToolchain();
    testInstallAndAcquireToolchain();
    testAcquireReportsMissingToolchain();
}

runCmakeToolchainTests();
