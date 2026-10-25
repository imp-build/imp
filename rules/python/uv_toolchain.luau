-- Graph acquisition and persistent data cache for uv.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("uv")
local DEFAULT_LOCKFILE = "@imp/rules/python/uv-toolchain.lock"
local graphs = {}
local cache_tool = nil
local triples = {
	["linux-x86_64"] = "x86_64-unknown-linux-gnu", ["linux-aarch64"] = "aarch64-unknown-linux-gnu",
	["macos-x86_64"] = "x86_64-apple-darwin", ["macos-aarch64"] = "aarch64-apple-darwin",
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
local function artifact_name(_version, plat)
	local triple = assert(triples[`{plat.os}-{plat.arch}`], `unsupported uv toolchain platform: {plat.os}/{plat.arch}`)
	return `uv-{triple}.{if plat.os == "windows" then "zip" else "tar.gz"}`
end
local function download_url(version, plat)
	return `https://github.com/astral-sh/uv/releases/download/{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "uv-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "0.11.16", "0.12.13" })

-- A graph dependency creates the cache before its first mount. Publishing
-- the same named-cache key preserves the directory and its existing files.
--- Return the shared cache tool, independent of a default uv version.
local function data_tool()
	if cache_tool then return cache_tool end
	local seed = core.task({
		display = "seed uv-cache-dir",
		inputs = { shell = core.native_tool("sh"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = { "sh", "-c", 'mkdir -p "$1"', "seed-uv-cache-dir", "cache" },
				tools = { inputs.shell, inputs.mkdir },
				outputs = { directory = core.output.directory("cache", { named_cache = { name = "uv-cache-dir", key = "shared" } }) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	cache_tool = core.tool(seed.outputs.directory, { name = "uv-cache-dir", bin_dirs = {} })
	return cache_tool
end
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "uv-toolchain",
		version = version, plat = plat,
		url = download_url(version, plat), output = `uv-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download uv {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "uv-toolchain", format = if plat.os == "windows" then "zip" else "tar.gz",
		strip_components = if plat.os == "windows" then nil else 1,
		named_cache = { name = "uv-toolchains", key = key }, display = `install uv {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "uv", bin_dirs = { "." } }), cache_tool = data_tool(), version = version })
end

--- Declare uv version. Options: default, lockfile, and unverified.
--- Return version metadata and a GEN_LOCKFILES root. The default lockfile
--- ships with Imp; use an @workspace/ address for a workspace-owned lock.
local function uv_toolchain(version, options)
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

--- Return { tool, cache_tool, version } for a declared or default version.
--- Declare both handles as task inputs before an action uses the cache.
local function graph_toolchain(version)
	local resolved = KIND.require_version(version)
	if graphs[resolved] == nil then graphs[resolved] = make_graph(resolved) end
	return graphs[resolved]
end

--- Return the absolute executable path inside a task with tool as an input.
local function uv_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "uv.exe" else "uv" })
end

--- Return absolute cache environment paths. cache must be a task input.
local function cache_env(exec, cache)
	local dir = exec.tool_dir(cache)
	return { UV_CACHE_DIR = dir, UV_PYTHON_INSTALL_DIR = dir .. "/python-install" }
end

local function reset_for_test()
	KIND.clear_default()
	graphs = {}
	cache_tool = nil
end
uv_toolchain("0.12.13", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("uv", function()
	return core.task({
		display = "resolve @uv",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = uv_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

return {
	cache_tool = data_tool, UV = KIND,
	--- @category configuration
	uv_toolchain = uv_toolchain, graph_toolchain = graph_toolchain,
	uv_bin = uv_bin, cache_env = cache_env, cache_key = cache_key,
	artifact_name = artifact_name, download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
}
