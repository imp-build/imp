-- The managed mold linker toolchain.
--
-- `mold_toolchain(version, options)` declares a version. The module declares
-- the pinned default when it loads on Linux. `graph_toolchain(version)`
-- returns `{ tool, version }`, where `tool` is a `core.tool()` handle on the
-- installed tree. A task that links with mold declares that tool handle as
-- an input, and gives it to `rust_linker_env` or `odin_linker_env`.
--
-- `imp @mold` runs the installed default mold. Local cache imports and
-- legacy JavaScript run descriptors are not provided.
local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")

local MOLD_TOOLCHAIN_CACHE = "mold-toolchains"
local DEFAULT_LOCKFILE = "@imp/rules/c/mold/mold.lock"

local MOLD = toolchain.define("mold")

-- mold publishes prebuilt Linux binaries only.
local SUPPORTED_PLATFORMS = {
	{ os = "linux", arch = "x86_64" },
	{ os = "linux", arch = "aarch64" },
}

local function require_supported_platform(plat)
	if plat.os ~= "linux" then
		error(`unsupported mold toolchain OS: {plat.os}`, 3)
	end
	if plat.arch ~= "x86_64" and plat.arch ~= "aarch64" then
		error(`unsupported mold toolchain architecture: {plat.arch}`, 3)
	end
end

--- The mold release archive filename for a version and platform.
local function artifact_name(version, plat)
	require_supported_platform(plat)
	return `mold-{version}-{plat.arch}-linux.tar.gz`
end

--- The mold release download URL for a version and platform.
local function download_url(version, plat)
	return `https://github.com/rui314/mold/releases/download/v{version}/{artifact_name(version, plat)}`
end

--- The platforms that mold publishes release archives for.
local function supported_platforms()
	local platforms = {}
	for _, plat in ipairs(SUPPORTED_PLATFORMS) do
		table.insert(platforms, table.clone(plat))
	end
	return platforms
end

--- The named-cache key for a mold version and platform.
local function cache_key(version, plat)
	return `{version}/{plat.os}-{plat.arch}`
end

local LOCKFILE_SPEC = lockfiles.register_toolchain_lockfile({
	name = "mold",
	platforms = supported_platforms(),
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, { "2.41.0", "2.42.1" })

--- Declare the install of a mold version and return its tool handle. The
--- task downloads the release archive, verifies it against the lockfile of
--- the version, and extracts it into the `mold-toolchains` named cache.
local function graph_tool(version)
	local resolved = MOLD.require_version(version)
	local plat = core.platform_info()
	local key = cache_key(resolved, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(MOLD, resolved, DEFAULT_LOCKFILE),
		tool = "mold",
		version = resolved,
		plat = plat,
		url = download_url(resolved, plat),
		output = `mold-downloads/{key}/{artifact_name(resolved, plat)}`,
		display = `download mold {resolved} ({plat.os}/{plat.arch})`,
		unverified = MOLD.resolve_unverified(resolved),
	})
	-- The release archive has bin/mold and bin/ld.mold. clang's
	-- -fuse-ld=mold looks for ld.mold, so no wrapper is necessary.
	local directory = archive.extract_archive({
		archive = downloaded,
		dest = "mold-toolchain",
		format = "tar.gz",
		strip_components = 1,
		named_cache = { name = MOLD_TOOLCHAIN_CACHE, key = key },
		display = `install mold {resolved} ({plat.os}/{plat.arch})`,
	})
	return core.tool(directory, { name = "mold", bin_dirs = { "bin" } })
end

-- The tool handle of each declared version, made when the version is
-- declared, so that each caller shares one install task.
local graph_tools = {}

local function graph_tool_for(version)
	local tool = graph_tools[version]
	if tool == nil then
		tool = graph_tool(version)
		graph_tools[version] = tool
	end
	return tool
end

--- Declare a mold toolchain version.
---
--- Options:
---   default     Make this version the default.
---   unverified  Download without a lockfile entry, with a warning.
---   lockfile    Address of a lockfile to use instead of the shipped one,
---               for example "@workspace/locks/mold.lock".
---
--- Returns `{ version, lockfile, [GEN_LOCKFILES] }`. Export the value from a
--- BUILD module to make its lockfile root selectable by
--- `imp goal gen-lockfiles`.
local function mold_toolchain(version, options)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	-- Fail on a malformed address when the toolchain is declared, not when
	-- it is first installed.
	local ok, problem = pcall(lockfile.lockfile_address_to_path, address)
	if not ok then
		error(problem, 2)
	end
	MOLD.declare(version, {
		default = options.default,
		lockfile = address,
		unverified = options.unverified,
	})
	graph_tools[version] = graph_tool(version)
	local spec = table.clone(LOCKFILE_SPEC)
	spec.version = version
	spec.lockfile = address
	return {
		version = version,
		lockfile = address,
		[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec),
	}
end

--- The graph-native mold toolchain of a version, or of the default:
--- `{ tool, version }`.
local function graph_toolchain(version)
	local resolved = MOLD.require_version(version)
	return table.freeze({ tool = graph_tool_for(resolved), version = resolved })
end

--- The graph-native mold toolchain of the default version, or nil when no
--- default is declared.
local function default_graph_toolchain()
	local version = MOLD.default_version()
	return if version then graph_toolchain(version) else nil
end

--- The absolute `bin` directory of an installed mold. `mold_tool` is the
--- `tool` of `graph_toolchain()`, declared as an input of the calling task.
local function bin_dir(exec, mold_tool)
	return exec.tool_dir(mold_tool) .. "/bin"
end

--- The rustflags and PATH directories that make rustc link with mold.
---
--- The Bootlin-built gcc rejects an absolute `-fuse-ld=<path>`, so the
--- flag keeps the bare `-fuse-ld=mold` form. `path_dirs` has the absolute
--- `bin` directory of mold, for the caller to add to PATH.
local function rust_linker_env(exec, mold_tool)
	return {
		rustflags = { "-C", "link-arg=-fuse-ld=mold" },
		path_dirs = { bin_dir(exec, mold_tool) },
	}
end

--- The flags and PATH directories that make Odin link with mold. Odin runs
--- its linker by name, so mold must be on PATH.
local function odin_linker_env(exec, mold_tool)
	return {
		flags = { "-linker:mold" },
		path_dirs = { bin_dir(exec, mold_tool) },
	}
end

--- Forget each declared version and the default. Tests call this, because
--- the module declares a default when it loads.
local function reset_for_test()
	MOLD.clear_default()
	graph_tools = {}
end

-- mold publishes no Windows or macOS build. Declare the pinned default only
-- on Linux, so that the import does not fail on other platforms. A
-- workspace can declare its own default with `mold_toolchain(...)`.
if core.platform_info().os == "linux" then
	mold_toolchain("2.42.1", { default = true })
end

-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("mold", function()
	return core.task({
		display = "resolve @mold",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = toolchain.bin(exec, inputs.tool, { sub_dir = "bin", exe = "mold" }) }
		end,
	}).outputs.value
end)

return {
	MOLD = MOLD,
	artifact_name = artifact_name,
	cache_key = cache_key,
	default_graph_toolchain = default_graph_toolchain,
	default_version = MOLD.default_version,
	download_url = download_url,
	graph_tool = graph_tool,
	graph_toolchain = graph_toolchain,

	--- @category configuration
	mold_toolchain = mold_toolchain,
	odin_linker_env = odin_linker_env,
	reset_for_test = reset_for_test,
	resolve_version = MOLD.resolve_version,
	rust_linker_env = rust_linker_env,
	supported_platforms = supported_platforms,
}
