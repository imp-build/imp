local core = require("@imp/core")
local generator = require("@imp/rules/rust/generate_build")
return {
	core.test.case("Rust generator matches the requested workspace manifest", function()
		local metadata = {
			workspace_root = "/sandbox",
			packages = {
				{ name = "root", manifest_path = "/sandbox/Cargo.toml" },
				{ name = "a", manifest_path = "/sandbox/crates/a/Cargo.toml" },
			},
		}
		assert(generator.package_for_manifest(metadata, "Cargo.toml").name == "root")
		assert(generator.package_for_manifest(metadata, "crates/a/Cargo.toml").name == "a")
		assert(generator.package_for_manifest(metadata, "other/Cargo.toml") == nil)
	end),
	core.test.case("Rust generator normalizes Windows paths and emits Luau properties", function()
		local metadata = {
			workspace_root = "C:\\repo",
			packages = {
				{
					name = "end",
					manifest_path = "C:\\repo\\crates\\end\\Cargo.toml",
					targets = {
						{ name = "one", kind = { "bin" } },
						{ name = "two", kind = { "bin" } },
						{ name = "lib", kind = { "lib" } },
					},
				},
			},
		}
		local target = generator.declarations(metadata, "crates/end/Cargo.toml")
		assert(target.name == "_end" and target.rule == "cargo_package")
		assert(target.props.workspace_member == true and #target.props.bin == 2)
	end),
	core.test.case("Rust generator emits library and standalone targets without binary or member flags", function()
		local metadata = {
			workspace_root = "/sandbox/app",
			packages = {
				{ name = "my-lib", manifest_path = "/sandbox/app/Cargo.toml", targets = { { kind = { "lib" } } } },
			},
		}
		local target = generator.declarations(metadata, "app/Cargo.toml")
		assert(target.name == "my_lib" and target.props.bin == nil and target.props.workspace_member == nil)
	end),
}
