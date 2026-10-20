-- Graph acquisition for the zola toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("zola")
local DEFAULT_LOCKFILE = "@imp/rules/zola/zola.lock"
local graphs = {}
local triples = {
	["linux-x86_64"] = "x86_64-unknown-linux-gnu",
	["linux-aarch64"] = "aarch64-unknown-linux-gnu",
	["macos-x86_64"] = "x86_64-apple-darwin",
	["macos-aarch64"] = "aarch64-apple-darwin",
	["windows-x86_64"] = "x86_64-pc-windows-msvc",
}
local function supported_platforms()
	local result = {}
	for _, key in ipairs({ "linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64", "windows-x86_64" }) do
		local os, arch = string.match(key, "^([^-]+)%-(.+)$")
		table.insert(result, { os = os, arch = arch })
	end
	return result
end
local function artifact_name(version, plat)
	local triple = assert(triples[`{plat.os}-{plat.arch}`], `unsupported zola toolchain platform: {plat.os}/{plat.arch}`)
	return `zola-v{version}-{triple}.{if plat.os == "windows" then "zip" else "tar.gz"}`
end
local function download_url(version, plat)
	return `https://github.com/getzola/zola/releases/download/v{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "zola", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "0.22.1", "0.23.6" })
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "zola",
		version = version, plat = plat, url = download_url(version, plat),
		output = `zola-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download zola {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "zola-toolchain", format = if plat.os == "windows" then "zip" else "tar.gz",
		named_cache = { name = "zola-toolchains", key = key }, display = `install zola {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "zola", bin_dirs = { "." } }), version = version })
end

--- Declare zola. Options: default, lockfile, and unverified.
--- Return version, lockfile, and a GEN_LOCKFILES root.
local function zola_toolchain(version, options)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	KIND.declare(version, { default = options.default, lockfile = address, unverified = options.unverified })
	graphs[version] = make_graph(version)
	local spec = table.clone(SPEC)
	spec.version = version
	spec.lockfile = address
	return { version = version, lockfile = address, [lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec) }
end

--- Return { tool, version } for a declared or default version.
local function graph_toolchain(version)
	local resolved = KIND.require_version(version)
	if graphs[resolved] == nil then graphs[resolved] = make_graph(resolved) end
	return graphs[resolved]
end

--- Return the absolute executable path. The tool must be a task input.
local function zola_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "zola.exe" else "zola" })
end
local function reset_for_test()
	KIND.clear_default()
	graphs = {}
end
zola_toolchain("0.23.6", { default = true })
return {
	ZOLA = KIND, zola_toolchain = zola_toolchain, graph_toolchain = graph_toolchain,
	zola_bin = zola_bin, cache_key = cache_key, artifact_name = artifact_name,
	download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
}
