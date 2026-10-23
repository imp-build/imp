-- Graph acquisition for the Ruff toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local archive = require("@imp/rules/imp/archive")
local KIND = toolchain.define("ruff")
local DEFAULT_LOCKFILE = "@imp/rules/python/ruff-toolchain.lock"
local graphs = {}
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
	local triple = assert(triples[`{plat.os}-{plat.arch}`], `unsupported ruff toolchain platform: {plat.os}/{plat.arch}`)
	return `ruff-{triple}.{if plat.os == "windows" then "zip" else "tar.gz"}`
end
local function download_url(version, plat)
	return `https://github.com/astral-sh/ruff/releases/download/{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "ruff-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "0.15.20", "0.15.21", "0.16.7" })

local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "ruff-toolchain",
		version = version, plat = plat,
		url = download_url(version, plat), output = `ruff-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download ruff {version}`, unverified = KIND.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded, dest = "ruff-toolchain", format = if plat.os == "windows" then "zip" else "tar.gz",
		strip_components = if plat.os == "windows" then nil else 1,
		named_cache = { name = "ruff-toolchains", key = key }, display = `install ruff {version}`,
	})
	return table.freeze({ tool = core.tool(directory, { name = "ruff", bin_dirs = { "." } }), version = version })
end

--- Declare ruff version. Options: default, lockfile, and unverified.
--- Return version metadata and a GEN_LOCKFILES root. The default lockfile
--- ships with Imp; use an @workspace/ address for a workspace-owned lock.
local function ruff_toolchain(version, options)
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
--- Declare the tool as a task input before an action uses it.
local function graph_toolchain(version)
	local resolved = KIND.require_version(version)
	if graphs[resolved] == nil then graphs[resolved] = make_graph(resolved) end
	return graphs[resolved]
end

--- Return the absolute executable path inside a task with tool as an input.
local function ruff_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "ruff.exe" else "ruff" })
end

local function reset_for_test()
	KIND.clear_default()
	graphs = {}
end
ruff_toolchain("0.16.7", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("ruff", function()
	return core.task({
		display = "resolve @ruff",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = ruff_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

--- Install a declared directory artifact or path handle. Options: default.
--- Return the graph tool and version. The source digest identifies the cache.
local function install_ruff_toolchain(version, source, options)
	assert(type(source) == "userdata", "install_ruff_toolchain requires a declared directory artifact or path handle")
	KIND.declare(version, options or {})
	-- Normalize path handles to a directory artifact before reading its digest.
	local captured = core.task({
		inputs = { source = source, sh = core.native_tool("sh"), cp = core.native_tool("cp"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec, input)
			local result = exec.action({
				argv = { "sh", "-c", 'if [ "$1" != "$2" ]; then mkdir -p "$2" && cp -R "$1/." "$2/"; fi', "capture-local-ruff", exec.path(input.source), "captured-ruff" },
				inputs = { input.source }, outputs = { directory = core.output.directory("captured-ruff") },
			})
			return { directory = result.outputs.directory }
		end,
	})
	local installed = core.task({
		display = `install local ruff {version}`,
		inputs = { source = captured.outputs.directory, sh = core.native_tool("sh"), cp = core.native_tool("cp"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec, input)
			local key = cache_key(version, core.platform_info()) .. "/" .. string.gsub(exec.digest(input.source), ":", "-")
			local result = exec.action({
				argv = { "sh", "-c", 'mkdir -p "$2" && cp -R "$1/." "$2/"', "install-local-ruff", exec.path(input.source), "ruff-local" },
				inputs = { input.source },
				outputs = { directory = core.output.directory("ruff-local", { named_cache = { name = "ruff-local-toolchains", key = key } }) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	graphs[version] = table.freeze({ tool = core.tool(installed.outputs.directory, { name = "ruff", bin_dirs = { "." } }), version = version })
	return graphs[version]
end

return {
	RUFF = KIND, ruff_toolchain = ruff_toolchain, graph_toolchain = graph_toolchain,
	ruff_bin = ruff_bin, cache_key = cache_key,
	artifact_name = artifact_name, download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test, install_ruff_toolchain = install_ruff_toolchain,
}
