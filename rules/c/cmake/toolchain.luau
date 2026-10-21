-- The CMake toolchain: the `cmake` program itself. It is not the C or C++
-- compiler toolchain that a CMake project builds with.
--
-- A graph task downloads the pinned CMake release archive, verifies it
-- against the lockfile, and extracts it into the shared named cache
-- "cmake-toolchains". `core.tool()` makes a tool handle from that directory.
--
-- CMake writes its own absolute path into build.ninja, for example as the
-- CMAKE_COMMAND of a POST_BUILD `cmake -E copy` step. Later replay actions
-- read build.ninja in other sandboxes. The configure action thus runs CMake
-- through its absolute named-cache path (`cmake_bin`), and replay finds a
-- rewritten bare "cmake" through the tool handle.
--
-- Differences from the JavaScript module: there is no `CmakeToolchain`
-- class, `cmakeBin()` product, `installCmakeToolchain()`,
-- `cmakeGraphToolSpec()`, or `cmakeGraphToolchainDir()`. `imp @cmake` runs
-- the installed default CMake. `cmake_bin(exec, tool)` gives the
-- absolute path in a task body.
local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")

local CMAKE_TOOLCHAIN_CACHE = "cmake-toolchains"
local DEFAULT_LOCKFILE = "@imp/rules/c/cmake/cmake.lock"

local CMAKE = toolchain.define("cmake")

-- The Windows release archives of CMake use "arm64", not "aarch64".
local ARCH_NAME_BY_OS = table.freeze({
	linux = table.freeze({ x86_64 = "x86_64", aarch64 = "aarch64" }),
	windows = table.freeze({ x86_64 = "x86_64", aarch64 = "arm64" }),
})

local function require_supported_platform(plat)
	local arch_names = ARCH_NAME_BY_OS[plat.os]
	if arch_names == nil then
		error(`unsupported CMake toolchain OS: {plat.os}`, 3)
	end
	if arch_names[plat.arch] == nil then
		error(`unsupported CMake toolchain architecture: {plat.arch}`, 3)
	end
end

--- The CMake release artifact filename for a version and platform.
local function artifact_name(version, plat)
	require_supported_platform(plat)
	local arch = ARCH_NAME_BY_OS[plat.os][plat.arch]
	local ext = if plat.os == "windows" then "zip" else "tar.gz"
	return `cmake-{version}-{plat.os}-{arch}.{ext}`
end

--- The CMake release download URL for a version and platform.
local function download_url(version, plat)
	return `https://github.com/Kitware/CMake/releases/download/v{version}/{artifact_name(version, plat)}`
end

--- The platforms that CMake publishes release archives for.
local function supported_platforms()
	local platforms = {}
	for _, os in ipairs({ "linux", "windows" }) do
		for _, arch in ipairs({ "x86_64", "aarch64" }) do
			table.insert(platforms, { os = os, arch = arch })
		end
	end
	return platforms
end

--- The named-cache key of a CMake version and platform.
local function cache_key(version, plat)
	return `{version}/{plat.os}-{plat.arch}`
end

local LOCKFILE_SPEC = lockfiles.register_toolchain_lockfile({
	name = "cmake",
	platforms = supported_platforms(),
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, { "3.31.0", "4.0.7", "4.1.6", "4.2.8", "4.3.5", "4.4.3" })

--- Declare the graph tasks that install CMake `version` (or the default),
--- and return its tool handle. The handle puts `bin` on PATH.
local function graph_tool(version)
	local resolved = CMAKE.require_version(version)
	local plat = core.platform_info()
	local key = cache_key(resolved, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(CMAKE, resolved, DEFAULT_LOCKFILE),
		tool = "cmake",
		version = resolved,
		plat = plat,
		url = download_url(resolved, plat),
		output = `cmake-downloads/{key}/{artifact_name(resolved, plat)}`,
		display = `download cmake {resolved} ({plat.os}/{plat.arch})`,
		unverified = CMAKE.resolve_unverified(resolved),
	})
	-- On Windows the archive is a zip, which unzip extracts. See
	-- @imp/rules/imp/archive for why tar is not used.
	local directory = archive.extract_archive({
		archive = downloaded,
		dest = "cmake-toolchain",
		format = if plat.os == "windows" then "zip" else "tar.gz",
		strip_components = 1,
		named_cache = { name = CMAKE_TOOLCHAIN_CACHE, key = key },
		display = `install cmake {resolved} ({plat.os}/{plat.arch})`,
	})
	return core.tool(directory, { name = "cmake", bin_dirs = { "bin" } })
end

-- One tool handle for each declared version, made at declaration time.
local graph_tools = {}

local function graph_tool_for(version)
	local tool = graph_tools[version]
	if tool == nil then
		tool = graph_tool(version)
		graph_tools[version] = tool
	end
	return tool
end

--- Declare CMake `version`. Options: `default`, `unverified` (download
--- without a matching lockfile entry), and `lockfile` (an `@workspace/` or
--- `@imp/rules/` address used in place of the shipped lockfile). The result
--- has a `GEN_LOCKFILES` root.
local function cmake_toolchain(version, options)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	-- Fail on a malformed address at declaration time.
	local ok, problem = pcall(lockfile.lockfile_address_to_path, address)
	if not ok then
		error(problem, 2)
	end
	CMAKE.declare(version, {
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

--- `{ tool, version }` for CMake `version`, or for the default.
local function graph_toolchain(version)
	local resolved = CMAKE.require_version(version)
	return table.freeze({ tool = graph_tool_for(resolved), version = resolved })
end

--- The default CMake toolchain, or nil when no default is declared.
local function default_graph_toolchain()
	local version = CMAKE.default_version()
	return if version then graph_toolchain(version) else nil
end

--- The absolute host path of the cmake executable. Call it in a task body.
--- `cmake_tool` is the `tool` of `graph_toolchain()`, declared as a task
--- input.
local function cmake_bin(exec, cmake_tool)
	local exe = if core.platform_info().os == "windows" then "cmake.exe" else "cmake"
	return toolchain.bin(exec, cmake_tool, { sub_dir = "bin", exe = exe })
end

local function reset_for_test()
	CMAKE.clear_default()
	graph_tools = {}
end

-- Loading this module declares the pinned default. A workspace can replace
-- it with another `cmake_toolchain(version, { default = true })`.
local plat = core.platform_info()
if ARCH_NAME_BY_OS[plat.os] ~= nil and ARCH_NAME_BY_OS[plat.os][plat.arch] ~= nil then
	cmake_toolchain("4.4.3", { default = true })
end

-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("cmake", function()
	return core.task({
		display = "resolve @cmake",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = cmake_bin(exec, inputs.tool) }
		end,
	}).outputs.value
end)

return {
	CMAKE = CMAKE,
	artifact_name = artifact_name,
	cache_key = cache_key,
	cmake_bin = cmake_bin,
	cmake_toolchain = cmake_toolchain,
	default_graph_toolchain = default_graph_toolchain,
	default_version = CMAKE.default_version,
	download_url = download_url,
	graph_tool = graph_tool,
	graph_toolchain = graph_toolchain,
	reset_for_test = reset_for_test,
	resolve_version = CMAKE.resolve_version,
	supported_platforms = supported_platforms,
}
