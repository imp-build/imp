-- Rust acquisition uses two persistent homes. Declare both tools as task inputs.
-- Local cache imports, legacy run descriptors, and imp @tool are not provided.
local core = require("@imp/core")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")
local RUST = toolchain.define("rust")
local DEFAULT_LOCKFILE = "@imp/rules/rust/rust.lock"
local triples = {
	["linux-x86_64"] = "x86_64-unknown-linux-gnu",
	["linux-aarch64"] = "aarch64-unknown-linux-gnu",
	["macos-x86_64"] = "x86_64-apple-darwin",
	["macos-aarch64"] = "aarch64-apple-darwin",
	["windows-x86_64"] = "x86_64-pc-windows-msvc",
}
local function target_triple(plat)
	local triple = triples[`{plat.os}-{plat.arch}`]
	assert(triple, `unsupported rust toolchain platform: {plat.os}/{plat.arch}`)
	return triple
end
local function pinned(version)
	assert(type(version) == "string" and string.match(version, "^%d+%.%d+%.%d+$"), `rust toolchain version must be an exact version like "1.79.0", got "{version}"`)
	return version
end
local function artifact_name(_version, plat)
	target_triple(plat)
	return if plat.os == "windows" then "rustup-init.exe" else "rustup-init"
end
local function download_url(version, plat)
	return `https://static.rust-lang.org/rustup/archive/1.27.1/{target_triple(plat)}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat)
	return `{version}/{plat.os}-{plat.arch}`
end
local function toolchain_id(version, plat)
	return `{version}-{target_triple(plat)}`
end
local function supported_platforms()
	local result = {}
	for _, key in ipairs({ "linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64", "windows-x86_64" }) do
		local os, arch = string.match(key, "^([^-]+)%-(.+)$")
		table.insert(result, { os = os, arch = arch })
	end
	return result
end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "rust", platforms = supported_platforms(), download_url = download_url,
	artifact_name = artifact_name, lockfile = DEFAULT_LOCKFILE,
}, { "1.93.0", "1.94.1", "1.95.0", "1.96.1", "1.97.1", "1.98.1" })
local graphs = {}
local declarations = {}
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local id = toolchain_id(version, plat)
	local installer = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(RUST, version, DEFAULT_LOCKFILE), tool = "rust", version = version,
		plat = plat, url = download_url(version, plat), output = `rust-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download rustup-init for rust {version} ({plat.os}/{plat.arch})`, unverified = RUST.resolve_unverified(version),
	})
	local inputs = { installer = installer, shell = core.native_tool("sh"), cp = core.native_tool("cp") }
	if plat.os ~= "windows" then inputs.chmod = core.native_tool("chmod") end
	local install = core.task({
		display = `install rust {version} ({plat.os}/{plat.arch})`, inputs = inputs,
		outputs = { rustup_home = core.output.artifact(), cargo_home = core.output.artifact() },
		run = function(exec, resolved)
			local chmod = if plat.os == "windows" then "" else "chmod +x ./$2; "
			local result = exec.action({
				argv = { "sh", "-c", 'set -e; cp "$1" ./"$2"; ' .. chmod .. 'export RUSTUP_HOME="$PWD/rustup-home" CARGO_HOME="$PWD/cargo-home"; ./"$2" -y --no-modify-path --profile minimal --component rustfmt --component clippy --default-toolchain "$3"', "install-rust", exec.path(resolved.installer), artifact_name(version, plat), version },
				inputs = { resolved.installer },
				outputs = {
					rustup_home = core.output.directory("rustup-home", { named_cache = { name = "rustup-home", key = key } }),
					cargo_home = core.output.directory("cargo-home", { named_cache = { name = "cargo-home", key = key } }),
				}, display = `install rust {version} ({plat.os}/{plat.arch})`,
			})
			return { rustup_home = result.outputs.rustup_home, cargo_home = result.outputs.cargo_home }
		end,
	})
	return table.freeze({
		tool = core.tool(install.outputs.rustup_home, { name = "rustup-home", bin_dirs = { `toolchains/{id}/bin` } }),
		cargo_home_tool = core.tool(install.outputs.cargo_home, { name = "cargo-home", bin_dirs = { "bin" } }),
		rustup_home = install.outputs.rustup_home, cargo_home = install.outputs.cargo_home,
		version = version, toolchain_id = id,
	})
end
local function rust_toolchain(version, options)
	pinned(version)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	RUST.declare(version, { default = options.default, lockfile = address, unverified = options.unverified })
	graphs[version] = make_graph(version)
	local spec = table.clone(SPEC)
	spec.version = version
	spec.lockfile = address
	local declaration = { version = version, lockfile = address, link_driver = options.link_driver, linker = options.linker, kache = options.kache, [lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec) }
	declarations[version] = declaration
	return declaration
end
local function graph_toolchain(version)
	local resolved = RUST.require_version(version)
	if not graphs[resolved] then graphs[resolved] = make_graph(pinned(resolved)) end
	return graphs[resolved]
end
-- Call in a task with both tool handles declared as inputs. Kache uses the
-- absolute cache paths, which remain stable across action sandboxes.
local function graph_tool_env(exec, rustup_tool, cargo_tool, id, _version, kache_active)
	if not kache_active then
		return { env = { RUSTUP_HOME = ".imp/tools/rustup-home", CARGO_HOME = ".imp/tools/cargo-home" } }
	end
	local rustup = exec.tool_dir(rustup_tool)
	local cargo = exec.tool_dir(cargo_tool)
	return { env = { RUSTUP_HOME = rustup, CARGO_HOME = cargo, PATH = `{rustup}/toolchains/{id}/bin:{cargo}/bin` } }
end
rust_toolchain("1.98.1", { default = true })
return {
	RUST = RUST, rust_toolchain = rust_toolchain, graph_toolchain = graph_toolchain,
	graph_tool_env = graph_tool_env, artifact_name = artifact_name, download_url = download_url,
	cache_key = cache_key, toolchain_id = toolchain_id, supported_platforms = supported_platforms,
	resolve_version = RUST.resolve_version, default_version = RUST.default_version,
	default_toolchain = function() return declarations[RUST.default_version()] end,
	reset_for_test = function() RUST.clear_default(); graphs = {}; declarations = {} end,
}
