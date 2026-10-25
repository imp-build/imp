-- Verified toolchain acquisition and version declarations.
local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")
local function supported_platforms()
	return { { os = "linux", arch = "x86_64" }, { os = "linux", arch = "aarch64" },
		{ os = "macos", arch = "x86_64" }, { os = "macos", arch = "aarch64" }, { os = "windows", arch = "x86_64" } }
end
local function artifact_name(version, plat)
	local arch = ({ x86_64 = "amd64", aarch64 = "arm64" })[plat.arch]
	assert(arch and (plat.os == "linux" or plat.os == "macos" or plat.os == "windows") and not (plat.os == "windows" and plat.arch == "aarch64"), `unsupported Odin platform {plat.os}/{plat.arch}`)
	return `odin-{plat.os}-{arch}-{version}.` .. (if plat.os == "windows" then "zip" else "tar.gz")
end
local function download_url(version, plat) return `https://github.com/odin-lang/Odin/releases/download/{version}/{artifact_name(version, plat)}` end
local function command_name(plat) return if plat.os == "windows" then "odin.exe" else "odin" end

local KIND = toolchain.define("odin")
local DEFAULT_LOCKFILE = "@imp/rules/odin/odin.lock"
local CACHE = "odin-toolchains"
local records = {}
local function resolve_version(version)
	return KIND.require_version(version)
end
local function cache_key(version, plat) return `{version}/{plat.os}-{plat.arch}` end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "odin", platforms = supported_platforms(), download_url = download_url,
	artifact_name = artifact_name, lockfile = DEFAULT_LOCKFILE,
}, { "dev-2026-03", "dev-2026-08" })
local function gen_lockfiles(version, options)
	options = options or {}
	local resolved = resolve_version(version)
	local spec = table.clone(SPEC)
	spec.version = resolved
	spec.lockfile = options.lockfile or lockfile.lockfile_for(KIND, resolved, DEFAULT_LOCKFILE)
	return { [lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec) }
end
local function make_record(version, options)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = address, tool = "odin", version = version, plat = plat,
		url = download_url(version, plat), output = `odin-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download odin {version} ({plat.os}/{plat.arch})`, unverified = options.unverified,
	})
	local installed = archive.extract_archive({
		archive = downloaded, dest = "odin-toolchain",
		format = if plat.os == "windows" then "zip" else "tar.gz",
		strip_components = 1, named_cache = { name = CACHE, key = key },
		display = `install odin {version} ({plat.os}/{plat.arch})`,
	})
	local value = { kind = "odin-toolchain", version = version, lockfile = address,
		tool = core.tool(installed, { name = "odin", bin_dirs = { "." } }),
		linker = options.linker, mingw_crt = options.mingw_crt == true, lld_on_windows = options.lld_on_windows == true }
	value[lockfiles.GEN_LOCKFILES] = gen_lockfiles(version, { lockfile = address })[lockfiles.GEN_LOCKFILES]
	return table.freeze(value)
end
--- Return the graph provider for a declared version or the current default.
local function graph_toolchain(version)
	local resolved = resolve_version(version)
	if not records[resolved] then
		local options = KIND.instance_for_version(resolved) or {}
		records[resolved] = make_record(resolved, options)
	end
	return records[resolved]
end
--- Declare a version. Options: default, lockfile, unverified, linker,
--- mingw_crt, and lld_on_windows. Export the result to select GEN_LOCKFILES.
local function declare(version, options)
	options = options or {}

	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	KIND.declare(version, { default = options.default, lockfile = address, unverified = options.unverified })
	records[version] = make_record(version, options)
	return records[version]
end
--- Return the executable path of a tool declared as a task input.
local function bin(exec, tool) return toolchain.bin(exec, tool, { exe = command_name(core.platform_info()) }) end
declare("dev-2026-08", { default = true })
toolchain.register("odin", function()
	return core.task({ inputs = { tool = graph_toolchain().tool }, outputs = { value = core.output.value() },
		run = function(exec, input) return { value = bin(exec, input.tool) } end }).outputs.value
end)
return {
	--- @category configuration
	odin_toolchain = declare, odin_gen_lockfiles = gen_lockfiles, graph_toolchain = graph_toolchain,
	default_version = function() return resolve_version() end, resolve_version = resolve_version,
	bin = bin, artifact_name = artifact_name, download_url = download_url, cache_key = cache_key,
	supported_platforms = supported_platforms, command_name = command_name,

}
