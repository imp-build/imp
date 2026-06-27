import {
    createOdinToolchainApi,
    odinArtifactName,
    odinCacheKey,
    odinDownloadUrl,
} from "//rules/odin/toolchain";

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
        download(url) {
            calls.push(["download", url]);
            return "/downloads/odin-release";
        },
        extract(archive, dest, opts) {
            calls.push(["extract", archive, dest, opts.format, opts.strip_components]);
        },
        cachePut(name, key, source) {
            calls.push(["cachePut", name, key, source]);
            cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
        },
    };
}

function testArtifactNames() {
    assertEqual(
        odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
        "odin-linux-amd64-dev-2026-03.tar.gz",
        "linux artifact name",
    );
    assertEqual(
        odinArtifactName("dev-2026-03", { os: "macos", arch: "aarch64" }),
        "odin-macos-arm64-dev-2026-03.tar.gz",
        "macos artifact name",
    );
    assertEqual(
        odinArtifactName("dev-2026-03", { os: "windows", arch: "x86_64" }),
        "odin-windows-amd64-dev-2026-03.zip",
        "windows artifact name",
    );
}

function testToolchainDeclaration() {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    const key = api.odinToolchain("dev-2026-03", { default: true });

    assertEqual(key, "odin-toolchains/dev-2026-03/linux-x86_64", "declared cache key");
    assertEqual(api.defaultOdinToolchainVersion(), "dev-2026-03", "default version");
    assertEqual(host.calls[0][0], "namedCache", "declares named cache first");
}

function testAcquireInstallsMissingToolchain() {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    const dir = api.acquireOdinToolchain("dev-2026-03");
    const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });

    assertEqual(dir, `/cache/odin-toolchains/${key}`, "installed toolchain dir");
    assert(
        host.calls.some((call) => call[0] === "download" && call[1] === odinDownloadUrl("dev-2026-03", { os: "linux", arch: "x86_64" })),
        "downloads expected Odin release URL",
    );
    assert(
        host.calls.some((call) => call[0] === "extract" && call[1] === "/downloads/odin-release" && call[2] === "/tmp/imp-odin-dev-2026-03-x86_64" && call[3] === "tar.gz" && call[4] === 1),
        "extracts release archive into staging dir",
    );
    assert(
        host.calls.some((call) => call[0] === "cachePut" && call[1] === "odin-toolchains" && call[2] === key && call[3] === "/tmp/imp-odin-dev-2026-03-x86_64"),
        "stores staged toolchain in named cache",
    );
}

function testAcquireUsesExistingCache() {
    const host = fakeHost();
    const api = createOdinToolchainApi(host);

    api.acquireOdinToolchain("dev-2026-03");
    host.calls.length = 0;

    const dir = api.acquireOdinToolchain("dev-2026-03");

    assertEqual(dir, "/cache/odin-toolchains/dev-2026-03/linux-x86_64", "cached toolchain dir");
    assert(!host.calls.some((call) => call[0] === "download"), "does not download cache hits");
    assert(!host.calls.some((call) => call[0] === "extract"), "does not extract cache hits");
}

function testOdinBinUsesDefaultVersion() {
    const host = fakeHost({ os: "windows", arch: "x86_64" });
    const api = createOdinToolchainApi(host);

    api.odinToolchain("dev-2026-03", { default: true });

    assertEqual(
        api.odinBin(),
        "/cache/odin-toolchains/dev-2026-03/windows-x86_64/odin.exe",
        "windows default odin binary",
    );
}

export function runOdinToolchainTests() {
    testArtifactNames();
    testToolchainDeclaration();
    testAcquireInstallsMissingToolchain();
    testAcquireUsesExistingCache();
    testOdinBinUsesDefaultVersion();
}

runOdinToolchainTests();
