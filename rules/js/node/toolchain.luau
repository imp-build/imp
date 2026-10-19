-- Graph acquisition for the node toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("node")
local DEFAULT_LOCKFILE = "@imp/rules/js/node/node-toolchain.lock"
local graphs = {}
local tokens = {
	["linux-x86_64"] = { os = "linux", arch = "x64" },
	["linux-aarch64"] = { os = "linux", arch = "arm64" },
	["macos-x86_64"] = { os = "darwin", arch = "x64" },
	["macos-aarch64"] = { os = "darwin", arch = "arm64" },
	["windows-x86_64"] = { os = "win", arch = "x64" },
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
	local token = assert(tokens[`{plat.os}-{plat.arch}`], `unsupported node toolchain platform: {plat.os}/{plat.arch}`)
	local ext = if plat.os == "windows" then "zip" else "tar.gz"
	return `node-v{version}-{token.os}-{token.arch}.{ext}`
end
local function download_url(version, plat)
	return `https://nodejs.org/dist/v{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "node-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "22.11.0", "22.13.1", "22.14.0", "22.15.1", "22.16.0", "22.17.1", "22.18.0", "22.19.0", "22.20.0", "22.21.1", "22.22.3", "22.23.2", "23.5.0", "23.6.1", "23.7.0", "23.8.0", "23.9.0", "23.10.0", "23.11.1", "24.0.2", "24.1.0", "24.2.0", "24.3.0", "24.4.1", "24.5.0", "24.6.0", "24.7.0", "24.8.0", "24.9.0", "24.10.0", "24.11.1", "24.12.0", "24.13.1", "24.14.1", "24.15.0", "24.16.0", "24.17.0", "24.18.1", "24.19.0", "24.20.0", "24.21.0", "25.0.0", "25.1.0", "25.2.1", "25.3.0", "25.4.0", "25.5.0", "25.6.1", "25.7.0", "25.8.2", "25.9.0", "26.0.0", "26.1.0", "26.2.0", "26.3.1", "26.4.0", "26.5.1", "26.6.0", "26.7.0", "26.8.2" })
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "node-toolchain",
		version = version, plat = plat, url = download_url(version, plat),
		output = `node-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download node {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "node-toolchain", format = if plat.os == "windows" then "zip" else "tar.gz",
		strip_components = 1,
		named_cache = { name = "node-toolchains", key = key }, display = `install node {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "node", bin_dirs = if plat.os == "windows" then { "." } else { "bin" } }), version = version })
end

--- Declare node. Options: default, lockfile, and unverified.
--- Return version, lockfile, and a GEN_LOCKFILES root.
local function node_toolchain(version, options)
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
local function node_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "node.exe" else "node", sub_dir = if core.platform_info().os == "windows" then "." else "bin" })
end
local function reset_for_test()
	KIND.clear_default()
	graphs = {}
end
node_toolchain("26.8.2", { default = true })
return {
	NODE = KIND, node_toolchain = node_toolchain, graph_toolchain = graph_toolchain,
	node_bin = node_bin, cache_key = cache_key, artifact_name = artifact_name,
	download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
}
