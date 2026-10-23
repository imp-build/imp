-- Verified toolchain acquisition and version declarations.
local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")
local odin = require("@imp/rules/odin/toolchain")
local triples = { ["linux/x86_64"] = "x86_64-unknown-linux-gnu", ["linux/aarch64"] = "arm64-unknown-linux-gnu",
	["macos/x86_64"] = "x86_64-darwin", ["macos/aarch64"] = "arm64-darwin", ["windows/x86_64"] = "x86_64-pc-windows-msvc" }
local function ols_triple(plat)
	local value = triples[plat.os .. "/" .. plat.arch]
	assert(value, `no odinfmt build for {plat.os}/{plat.arch}`)
	return value
end
local function command_name(plat) return "odinfmt-" .. ols_triple(plat) .. (if plat.os == "windows" then ".exe" else "") end
local function artifact_name(_version, plat) return `ols-{ols_triple(plat)}.zip` end
local function download_url(version, plat) return `https://github.com/DanielGavin/ols/releases/download/{version}/{artifact_name(version, plat)}` end
local function supported_platforms() return odin.supported_platforms() end

local KIND = toolchain.define("odinfmt")
local DEFAULT_LOCKFILE = "@imp/rules/odin/odinfmt/odinfmt.lock"
local CACHE = "odinfmt-toolchains"
local records = {}
local implicit_options, implicit_records = {}, {}
local follows_odin = true
local function resolve_version(version)
	return version or (if follows_odin then odin.resolve_version() else KIND.require_version())
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "odinfmt", platforms = supported_platforms(), download_url = download_url,
	artifact_name = artifact_name, lockfile = DEFAULT_LOCKFILE,
}, { "dev-2026-03", "dev-2026-08" })
local function gen_lockfiles(version, options)
	options = options or {}
	local resolved = resolve_version(version)
	local spec = table.clone(SPEC)
	spec.version = resolved
	spec.lockfile = options.lockfile or (if version == nil and follows_odin then implicit_options.lockfile else nil) or lockfile.lockfile_for(KIND, resolved, DEFAULT_LOCKFILE)
	return { [lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec) }
end
local function make_record(version, options)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = address, tool = "odinfmt", version = version, plat = plat,
		url = download_url(version, plat), output = `odinfmt-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download odinfmt {version} ({plat.os}/{plat.arch})`, unverified = options.unverified,
	})
	local installed = archive.extract_archive({
		archive = downloaded, dest = "odinfmt-toolchain",
		format = if plat.os == "windows" then "zip" else "zip-unix",
		strip_components = 0, named_cache = { name = CACHE, key = key },
		display = `install odinfmt {version} ({plat.os}/{plat.arch})`,
	})
	local value = { kind = "odinfmt-toolchain", version = version, lockfile = address,
		tool = core.tool(installed, { name = "odinfmt", bin_dirs = { "." } }) }
	value[lockfiles.GEN_LOCKFILES] = gen_lockfiles(version, { lockfile = address })[lockfiles.GEN_LOCKFILES]
	return table.freeze(value)
end
--- Return the graph provider for a declared version or the current default.
local function graph_toolchain(version)
	local resolved = resolve_version(version)
	if version == nil and follows_odin then
		if not implicit_records[resolved] then implicit_records[resolved] = make_record(resolved, implicit_options) end
		return implicit_records[resolved]
	end
	if not records[resolved] then
		local options = KIND.instance_for_version(resolved) or implicit_options
		records[resolved] = make_record(resolved, options)
	end
	return records[resolved]
end
--- Declare a version. Options: default, lockfile, and unverified.
--- Omit the version to follow Odin. Export the result to select GEN_LOCKFILES.
local function declare(version, options)
	options = options or {}
	if version == nil then
		implicit_options, implicit_records = table.clone(options), {}
		if options.default then follows_odin = true end
		return graph_toolchain()
	end
	if options.default then follows_odin = false end
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	KIND.declare(version, { default = options.default, lockfile = address, unverified = options.unverified })
	records[version] = make_record(version, options)
	return records[version]
end
--- Return the executable path of a tool declared as a task input.
local function bin(exec, tool) return toolchain.bin(exec, tool, { exe = command_name(core.platform_info()) }) end

toolchain.register("odinfmt", function()
	return core.task({ inputs = { tool = graph_toolchain().tool }, outputs = { value = core.output.value() },
		run = function(exec, input) return { value = bin(exec, input.tool) } end }).outputs.value
end)
return { odinfmt_toolchain = declare, odinfmt_gen_lockfiles = gen_lockfiles, graph_toolchain = graph_toolchain,
	default_version = function() return resolve_version() end, resolve_version = resolve_version,
	bin = bin, artifact_name = artifact_name, download_url = download_url, cache_key = cache_key,
	supported_platforms = supported_platforms, command_name = command_name,
	ols_triple = ols_triple,
}
