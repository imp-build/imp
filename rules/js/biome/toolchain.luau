-- Graph acquisition for the biome toolchain.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local KIND = toolchain.define("biome")
local DEFAULT_LOCKFILE = "@imp/rules/js/biome/biome-toolchain.lock"
local graphs = {}
local tokens = {
	["linux-x86_64"] = { os = "linux", arch = "x64" },
	["linux-aarch64"] = { os = "linux", arch = "arm64" },
	["macos-x86_64"] = { os = "darwin", arch = "x64" },
	["macos-aarch64"] = { os = "darwin", arch = "arm64" },
	["windows-x86_64"] = { os = "win32", arch = "x64" },
	["windows-aarch64"] = { os = "win32", arch = "arm64" },
}
local function supported_platforms()
	local result = {}
	for _, key in ipairs({ "linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64", "windows-x86_64", "windows-aarch64" }) do
		local os, arch = string.match(key, "^([^-]+)%-(.+)$")
		table.insert(result, { os = os, arch = arch })
	end
	return result
end
local function artifact_name(version, plat)
	local token = assert(tokens[`{plat.os}-{plat.arch}`], `unsupported biome toolchain platform: {plat.os}/{plat.arch}`)
	local ext = if plat.os == "windows" then ".exe" else ""
	return `biome-{token.os}-{token.arch}{ext}`
end
local function download_url(version, plat)
	return `https://github.com/biomejs/biome/releases/download/@biomejs/biome@{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "biome-toolchain", platforms = supported_platforms(), artifact_name = artifact_name,
	download_url = download_url, lockfile = DEFAULT_LOCKFILE,
}, { "2.5.4" })
local function install_graph(version, source, local_source)
	local plat = core.platform_info()
	local installed = core.task({
		display = `install biome {version}`,
		inputs = { source = source, sh = core.native_tool("sh"), cp = core.native_tool("cp"),
			mkdir = core.native_tool("mkdir"), chmod = if plat.os ~= "windows" then core.native_tool("chmod") else nil },
		outputs = { directory = core.output.artifact() },
		run = function(exec, input)
			local key = cache_key(version, plat)
			if local_source then key ..= "/" .. string.gsub(exec.digest(input.source), ":", "-") end
			local exe = if plat.os == "windows" then "biome.exe" else "biome"
			local script = 'mkdir -p "$2" && cp "$1" "$2/$3"'
			if plat.os ~= "windows" then script ..= ' && chmod +x "$2/$3"' end
			local result = exec.action({
				argv = { "sh", "-c", script, "install-biome", exec.path(input.source), "biome-toolchain", exe },
				inputs = { input.source },
				outputs = { directory = core.output.directory("biome-toolchain", {
					named_cache = { name = if local_source then "biome-local-toolchains" else "biome-toolchains", key = key },
				}) },
			})
			return { directory = result.outputs.directory }
		end,
	})
	return table.freeze({ tool = core.tool(installed.outputs.directory, { name = "biome", bin_dirs = { "." } }), version = version })
end
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KIND, version, DEFAULT_LOCKFILE), tool = "biome-toolchain",
		version = version, plat = plat, url = download_url(version, plat),
		output = `biome-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download biome {version}`, unverified = KIND.resolve_unverified(version),
	})
	return install_graph(version, downloaded, false)
end

--- Declare biome. Options: default, lockfile, and unverified.
--- Return version, lockfile, and a GEN_LOCKFILES root.
local function biome_toolchain(version, options)
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
local function biome_bin(exec, tool)
	return toolchain.bin(exec, tool, { exe = if core.platform_info().os == "windows" then "biome.exe" else "biome" })
end
local function reset_for_test()
	KIND.clear_default()
	graphs = {}
end
biome_toolchain("2.5.4", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("biome", function()
	return core.task({
		display = "resolve @biome",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = biome_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

--- Install a declared file artifact or path handle. Options: default.
--- Return a frozen tool/version graph value. No download or lockfile is used.
local function install_biome_toolchain(version, source, options)
	assert(type(source) == "userdata", "install_biome_toolchain requires a declared file artifact or path handle")
	KIND.declare(version, options or {})
	local captured = core.task({
		inputs = { source = source, cp = core.native_tool("cp"), sh = core.native_tool("sh") },
		outputs = { file = core.output.artifact() },
		run = function(exec, input)
			local result = exec.action({
				argv = { "sh", "-c", 'test "$1" = "$2" || cp "$1" "$2"', "capture-biome", exec.path(input.source), "local-biome" },
				inputs = { input.source }, outputs = { file = core.output.file("local-biome") },
			})
			return { file = result.outputs.file }
		end,
	})
	graphs[version] = install_graph(version, captured.outputs.file, true)
	return graphs[version]
end

return {
	BIOME = KIND, biome_toolchain = biome_toolchain, graph_toolchain = graph_toolchain,
	biome_bin = biome_bin, cache_key = cache_key, artifact_name = artifact_name,
	download_url = download_url, supported_platforms = supported_platforms,
	default_version = KIND.default_version, resolve_version = KIND.resolve_version,
	reset_for_test = reset_for_test,
	install_biome_toolchain = install_biome_toolchain,
}
