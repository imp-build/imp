-- Graph acquisition for the pnpm toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("pnpm")
local DEFAULT_LOCKFILE = "@imp/rules/js/pnpm/pnpm-toolchain.lock"
local graphs = {}
local tokens = {
	["linux-x86_64"] = { os = "linux", arch = "x64" },
	["linux-aarch64"] = { os = "linux", arch = "arm64" },
	["macos-aarch64"] = { os = "darwin", arch = "arm64" },
	["windows-x86_64"] = { os = "win32", arch = "x64" },
	["windows-aarch64"] = { os = "win32", arch = "arm64" },
}
local function supported_platforms()
	local result = {}
	for _, key in ipairs({ "linux-x86_64", "linux-aarch64", "macos-aarch64", "windows-x86_64", "windows-aarch64" }) do
		local os, arch = string.match(key, "^([^-]+)%-(.+)$")
		table.insert(result, { os = os, arch = arch })
	end
	return result
end
local function artifact_name(version, plat)
	local token = assert(tokens[`{plat.os}-{plat.arch}`], `unsupported pnpm toolchain platform: {plat.os}/{plat.arch}`)
	local ext = if plat.os == "windows" then "zip" else "tar.gz"
	return `pnpm-{token.os}-{token.arch}.{ext}`
end
local function download_url(version, plat)
	return `https://github.com/pnpm/pnpm/releases/download/v{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "pnpm-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "11.13.0", "11.14.0", "11.15.1", "11.16.0", "11.17.0", "11.18.0", "11.19.0", "11.20.0", "11.21.0", "11.22.0", "11.23.0", "11.24.0", "11.25.0", "11.26.0", "11.27.0", "12.0.0", "12.1.0", "12.2.1", "12.3.4", "12.4.1" })
local store = nil
--- Return the persistent pnpm store tool. Its directory does not enter PATH.
local function store_tool()
	if store then return store end
	local seed = core.task({
		inputs = { sh = core.native_tool("sh"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = { "sh", "-c", 'mkdir -p "$1"', "seed-pnpm-store", "store" },
				outputs = { directory = core.output.directory("store", { named_cache = { name = "pnpm-store", key = "shared" } }) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	store = core.tool(seed.outputs.directory, { name = "pnpm-store", bin_dirs = {} })
	return store
end
--- Return absolute store settings. The cache tool must be a task input.
local function store_env(exec, cache)
	return { npm_config_store_dir = exec.tool_dir(cache) }
end
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "pnpm-toolchain",
		version = version, plat = plat, url = download_url(version, plat),
		output = `pnpm-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download pnpm {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "pnpm-toolchain", format = if plat.os == "windows" then "zip" else "tar.gz",
		named_cache = { name = "pnpm-toolchains", key = key }, display = `install pnpm {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "pnpm", bin_dirs = { "." } }), version = version })
end

--- Declare pnpm. Options: default, lockfile, and unverified.
--- Return version, lockfile, and a GEN_LOCKFILES root.
local function pnpm_toolchain(version, options)
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
local function pnpm_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "pnpm.exe" else "pnpm" })
end
local function reset_for_test()
	KIND.clear_default()
	graphs = {}
	store = nil
end
pnpm_toolchain("12.4.1", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("pnpm", function()
	return core.task({
		display = "resolve @pnpm",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = pnpm_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

return {
	PNPM = KIND, pnpm_toolchain = pnpm_toolchain, graph_toolchain = graph_toolchain,
	pnpm_bin = pnpm_bin, cache_key = cache_key, artifact_name = artifact_name,
	download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
	store_tool = store_tool, store_env = store_env,
}
