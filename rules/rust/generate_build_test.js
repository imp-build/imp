import { describe, expect, test } from "//rules/imp/test";
import { cargoGenerateBuild, generateBuild, parse_cargo_package_name } from "//rules/rust/generate_build";

describe("rust generate-build", () => {

test("generateBuild product is exported as a function", () => {
    expect(typeof generateBuild).toBe("function");
});

test("cargoGenerateBuild declares a generator target", () => {
    const generator = cargoGenerateBuild({ root: "src" });
    expect(generator.kind).toBe("cargo-build-generator");
    expect(generator.attrs.root).toBe("src");
});

test("parse_cargo_package_name reads the [package] section's name", () => {
    const toml = [
        "[package]",
        'name = "hello"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'serde = "1"',
    ].join("\n");
    expect(parse_cargo_package_name(toml)).toBe("hello");
});

test("parse_cargo_package_name ignores name fields outside [package]", () => {
    const toml = [
        "[dependencies]",
        'name-lookalike = "1"',
        "",
        "[[bin]]",
        'name = "not-the-package-name"',
    ].join("\n");
    expect(parse_cargo_package_name(toml)).toBe(null);
});

test("parse_cargo_package_name stops at the next section header", () => {
    const toml = [
        "[package]",
        'version = "0.1.0"',
        "[dependencies]",
        'name = "wrong"',
    ].join("\n");
    expect(parse_cargo_package_name(toml)).toBe(null);
});

});
