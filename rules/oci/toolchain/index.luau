-- Graph acquisition for the crane toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("crane")
local DEFAULT_LOCKFILE = "@imp/rules/oci/crane.lock"
local graphs = {}
local tokens = {
	["linux-x86_64"] = { os = "Linux", arch = "x86_64" },
	["linux-aarch64"] = { os = "Linux", arch = "arm64" },
	["macos-x86_64"] = { os = "Darwin", arch = "x86_64" },
	["macos-aarch64"] = { os = "Darwin", arch = "arm64" },
	["windows-x86_64"] = { os = "Windows", arch = "x86_64" },
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
	local token = assert(tokens[`{plat.os}-{plat.arch}`], `unsupported crane toolchain platform: {plat.os}/{plat.arch}`)
	return `go-containerregistry_{token.os}_{token.arch}.tar.gz`
end
local function download_url(version, plat)
	return `https://github.com/google/go-containerregistry/releases/download/v{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "crane", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "0.20.6", "0.21.9", "0.22.1" })
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "crane",
		version = version, plat = plat, url = download_url(version, plat),
		output = `crane-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download crane {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "crane-toolchain", format = "tar.gz",
		named_cache = { name = "crane-toolchains", key = key }, display = `install crane {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "crane", bin_dirs = { "." } }), version = version })
end

--- Declare crane. Options: default, lockfile, and unverified.
--- Return version, lockfile, and a GEN_LOCKFILES root.
local function crane_toolchain(version, options)
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
local function crane_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "crane.exe" else "crane" })
end
local function reset_for_test()
	KIND.clear_default()
	graphs = {}
end
crane_toolchain("0.22.1", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("crane", function()
	return core.task({
		display = "resolve @crane",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = crane_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

return {
	CRANE = KIND, crane_toolchain = crane_toolchain, graph_toolchain = graph_toolchain,
	crane_bin = crane_bin, cache_key = cache_key, artifact_name = artifact_name,
	download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
}
