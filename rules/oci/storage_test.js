import { describe, expect, test, withFakeToolchainHost } from "//rules/imp/test";
import {
    __resetOciStorageStateForTest,
    craneAuthTools,
    declareOciStorage,
    OCI_STORAGE_CACHE,
    ociStorageKey,
} from "//rules/oci/storage";

describe("oci storage", () => {
test("ociStorageKey accepts a canonical digest", () => {
    expect(ociStorageKey("sha256:" + "a".repeat(64))).toBe("sha256/" + "a".repeat(64));
});

test("ociStorageKey rejects a malformed digest", () => {
    expect(() => ociStorageKey("sha256:not-hex")).toThrow("not a canonical digest");
    expect(() => ociStorageKey("latest")).toThrow("not a canonical digest");
    expect(() => ociStorageKey(null)).toThrow("not a canonical digest");
});

test("declareOciStorage declares the named cache once", async () => {
    await withFakeToolchainHost(async (host) => {
        __resetOciStorageStateForTest();
        declareOciStorage();
        declareOciStorage();
        __resetOciStorageStateForTest();

        expect(host.calls.filter((call) => call[0] === "namedCache" && call[1] === OCI_STORAGE_CACHE).length).toBe(1);
    });
});

test("craneAuthTools is currently a no-op placeholder", async () => {
    const result = await craneAuthTools("ghcr.io");
    expect(result.tools.length).toBe(0);
    expect(result.env.length).toBe(0);
});
});
