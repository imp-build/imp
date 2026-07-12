import { describe, expect, test } from "//rules/imp/test";
import { generateBuild, package_for_manifest } from "//rules/rust/generate_build";

describe("rust generate-build", () => {

test("generateBuild product is exported as a function", () => {
    expect(typeof generateBuild).toBe("function");
});

test("package_for_manifest matches the package whose manifest_path ends with the given path", () => {
    const metadata = {
        workspace_root: "/sandbox/repo",
        packages: [
            { name: "imp", manifest_path: "/sandbox/repo/Cargo.toml", targets: [] },
            { name: "imp-store", manifest_path: "/sandbox/repo/crates/imp-store/Cargo.toml", targets: [] },
        ],
    };
    const pkg = package_for_manifest(metadata, "crates/imp-store/Cargo.toml");
    expect(pkg.name).toBe("imp-store");
});

test("package_for_manifest returns null when no package matches", () => {
    const metadata = { workspace_root: "/sandbox/repo", packages: [] };
    expect(package_for_manifest(metadata, "crates/missing/Cargo.toml")).toBe(null);
});

});
