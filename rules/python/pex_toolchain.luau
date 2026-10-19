-- Graph acquisition and persistent data cache for pex.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local KIND = toolchain.define("pex")
local DEFAULT_LOCKFILE = "@imp/rules/python/pex-toolchain.lock"
local graphs = {}
local cache_tool = nil
local function supported_platforms() return { { os = "any", arch = "any" } } end
local function artifact_name() return "pex" end
local function download_url(version) return `https://github.com/pantsbuild/pex/releases/download/v{version}/pex` end
local function cache_key(version) return version end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "pex-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "2.97.1", "2.98.5", "2.99.0", "2.100.7", "2.101.6", "2.102.0" })

-- A graph dependency creates the cache before its first mount. Publishing
-- the same named-cache key preserves the directory and its existing files.
local function data_tool()
	if cache_tool then return cache_tool end
	local seed = core.task({
		display = "seed pex-root",
		inputs = { shell = core.native_tool("sh"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = { "sh", "-c", 'mkdir -p "$1"', "seed-pex-root", "cache" },
				tools = { inputs.shell, inputs.mkdir },
				outputs = { directory = core.output.directory("cache", { named_cache = { name = "pex-root", key = "shared" } }) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	cache_tool = core.tool(seed.outputs.directory, { name = "pex-root", bin_dirs = {} })
	return cache_tool
end
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "pex-toolchain",
		version = version, plat = plat, lock_plat = { os = "any", arch = "any" },
		url = download_url(version, plat), output = `pex-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download pex {version}`, unverified = KIND.resolve_unverified(version),
	})
	local shell = core.native_tool("sh")
	local tools = { shell = shell, cp = core.native_tool("cp"), mkdir = core.native_tool("mkdir") }
	if plat.os ~= "windows" then tools.chmod = core.native_tool("chmod") end
	tools.archive = downloaded
	local install = core.task({
		display = `install pex {version}`, inputs = tools, outputs = { directory = core.output.artifact() },
		run = function(exec, inputs)
			local script = 'mkdir -p "$2" && cp "$1" "$2/pex"'
			if plat.os ~= "windows" then script ..= ' && chmod +x "$2/pex"' end
			local result = exec.action({
				argv = { "sh", "-c", script, "install-pex", exec.path(inputs.archive), "toolchain" },
				display = `install pex {version}`,
				inputs = { inputs.archive },
				outputs = { directory = core.output.directory("toolchain", { named_cache = { name = "pex-toolchains", key = key } }) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	local directory = install.outputs.directory
	return table.freeze({ tool = core.tool(directory, { name = "pex", bin_dirs = { "." } }), cache_tool = data_tool(), version = version })
end

--- Declare pex version. Options: default, lockfile, and unverified.
--- Return version metadata and a GEN_LOCKFILES root. The default lockfile
--- ships with Imp; use an @workspace/ address for a workspace-owned lock.
local function pex_toolchain(version, options)
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
local function pex_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = "pex" })
end

--- Return absolute cache environment paths. cache must be a task input.
local function cache_env(exec, cache)
	local dir = exec.tool_dir(cache)
	return { PEX_ROOT = dir }
end

local function reset_for_test()
	KIND.clear_default()
	graphs = {}
	cache_tool = nil
end
pex_toolchain("2.102.0", { default = true })
return {
	PEX = KIND, pex_toolchain = pex_toolchain, graph_toolchain = graph_toolchain,
	pex_bin = pex_bin, cache_env = cache_env, cache_key = cache_key,
	artifact_name = artifact_name, download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
}
