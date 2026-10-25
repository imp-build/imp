-- The managed Zig toolchain, used as a C and C++ compiler.
--
-- `zig_toolchain(version, options)` declares a version. The module declares
-- the pinned default when it loads on a supported platform.
-- `graph_toolchain(version)` returns the Zig provider of the shared C
-- toolchain contract (see `@imp/rules/c/toolchain`), with `tool`,
-- `build_cache_tool`, and `version`. `tool` puts `zig` and the `zigar`,
-- `zigranlib`, `clang`, and `ar` wrappers on PATH. `build_cache_tool` is the
-- prewarmed Zig build cache.
--
-- `imp @zig` runs the installed default Zig. Local cache imports and
-- legacy JavaScript run descriptors are not provided.
local core = require("@imp/core")
local output = core.output
local c_toolchain = require("@imp/rules/c/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")

local shell_quote = c_toolchain.shell_quote

local ZIG_TOOLCHAIN_CACHE = "zig-toolchains"
-- Change this revision when installed wrapper content changes.
local INSTALL_REVISION = 2
-- Zig changes the prewarmed $ZIG_GLOBAL_CACHE_DIR when it builds runtime
-- support code. Zig addresses that content by what it compiles, not by the
-- Zig version, so one fixed key serves each version.
--
-- The JavaScript module keeps this cache in the workspace scope, because it
-- is mutable. A Luau named cache is always shared, so each workspace on the
-- computer writes into one directory. Zig locks its cache entries, so
-- concurrent writers are safe. Imp does not write an existing slot again,
-- so only the first prewarm on the computer fills the slot. Later builds
-- add to it.
local ZIG_BUILD_CACHE_CACHE = "zig-build-cache"
local ZIG_BUILD_CACHE_KEY = "shared"
local DEFAULT_LOCKFILE = "@imp/rules/c/zig/zig.lock"

local ZIG = toolchain.define("Zig")

-- The platforms that this module gets Zig for. Zig also ships macOS, but
-- this module does not support it, so the lockfile does not include it.
local SUPPORTED_PLATFORMS = {
	{ os = "linux", arch = "x86_64" },
	{ os = "linux", arch = "aarch64" },
	{ os = "windows", arch = "x86_64" },
	{ os = "windows", arch = "aarch64" },
}

local function is_supported_platform(plat)
	return (plat.os == "linux" or plat.os == "windows") and (plat.arch == "x86_64" or plat.arch == "aarch64")
end

local function require_supported_platform(plat)
	if plat.os ~= "linux" and plat.os ~= "windows" then
		error(`unsupported Zig toolchain OS: {plat.os}`, 3)
	end
	if plat.arch ~= "x86_64" and plat.arch ~= "aarch64" then
		error(`unsupported Zig toolchain architecture: {plat.arch}`, 3)
	end
end

-- Zig release archives were named zig-<os>-<arch>-<version> through 0.14.0,
-- and zig-<arch>-<os>-<version> from 0.14.1. A version that is not a plain
-- x.y.z release, for example a dev build, uses the current names.
local function uses_legacy_artifact_order(version)
	local major, minor, patch = string.match(version, "^(%d+)%.(%d+)%.(%d+)")
	if major == nil then
		return false
	end
	major, minor, patch = tonumber(major), tonumber(minor), tonumber(patch)
	if major ~= 0 then
		return false
	end
	return minor < 14 or (minor == 14 and patch == 0)
end

--- The Zig release archive filename for a version and platform.
local function artifact_name(version, plat)
	require_supported_platform(plat)
	local ext = if plat.os == "windows" then "zip" else "tar.xz"
	if uses_legacy_artifact_order(version) then
		return `zig-{plat.os}-{plat.arch}-{version}.{ext}`
	end
	return `zig-{plat.arch}-{plat.os}-{version}.{ext}`
end

--- The Zig release download URL for a version and platform.
local function download_url(version, plat)
	return `https://ziglang.org/download/{version}/{artifact_name(version, plat)}`
end

--- The platforms that this module gets Zig release archives for.
local function supported_platforms()
	local platforms = {}
	for _, plat in ipairs(SUPPORTED_PLATFORMS) do
		table.insert(platforms, table.clone(plat))
	end
	return platforms
end

--- The named-cache key for a Zig version and platform.
local function cache_key(version, plat)
	return `v{INSTALL_REVISION}/{version}/{plat.os}-{plat.arch}`
end

local LOCKFILE_SPEC = lockfiles.register_toolchain_lockfile({
	name = "zig",
	platforms = supported_platforms(),
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, { "0.16.0" })

-- The wrappers for CMAKE_AR and CMAKE_RANLIB, which must each be one
-- executable, and the generic `clang` and `ar` names for a caller, such as
-- Odin, that runs a fixed program name. Windows uses .bat files.
local function wrapper_names(plat)
	if plat.os == "windows" then
		return { ar = "zigar.bat", ranlib = "zigranlib.bat", clang = "clang.bat", generic_ar = "ar.bat" }
	end
	return { ar = "zigar", ranlib = "zigranlib", clang = "clang", generic_ar = "ar" }
end

local function wrapper_content(plat, zig_exe, subcommand)
	if plat.os == "windows" then
		return `@"%~dp0{zig_exe}" {subcommand} %*\r\n`
	end
	return `#!/bin/sh\nexec "$\{0%/*\}/{zig_exe}" {subcommand} "$@"\n`
end

-- The native tools of the install script. The sandbox is hermetic, so it
-- declares even coreutils. GNU tar runs `xz` for a .tar.xz file. Windows
-- extracts the .zip release with unzip, not tar: a Windows host can have the
-- tar of Git for Windows, which cannot read zip, and bsdtar, and the PATH
-- order selects one. A bare `sh` resolves only on Unix, so Windows declares
-- `sh`.
local function install_tool_names(plat)
	if plat.os == "windows" then
		return { "mkdir", "mv", "sh", "unzip" }
	end
	return { "chmod", "mkdir", "tar", "xz" }
end

-- A positional shell parameter. A parameter after $9 needs braces.
local function positional(n)
	return if n >= 10 then "${" .. n .. "}" else "$" .. n
end

--- Declare the download and install of a Zig version, and return the
--- artifact handle of the installed tree. The install writes the wrappers
--- of `wrapper_names` beside `zig`.
local function install_directory(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local archive = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(ZIG, version, DEFAULT_LOCKFILE),
		tool = "zig",
		version = version,
		plat = plat,
		url = download_url(version, plat),
		output = `zig-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download zig {version} ({plat.os}/{plat.arch})`,
		unverified = ZIG.resolve_unverified(version),
	})
	local zig_exe = if plat.os == "windows" then "zig.exe" else "zig"
	local names = wrapper_names(plat)
	local wrappers = {
		{ wrapper_content(plat, zig_exe, "ar"), names.ar },
		{ wrapper_content(plat, zig_exe, "ranlib"), names.ranlib },
		{ wrapper_content(plat, zig_exe, "cc"), names.clang },
		{ wrapper_content(plat, zig_exe, "ar"), names.generic_ar },
	}
	local wrapper_args = {}
	local writes = {}
	local chmods = {}
	for index, wrapper in ipairs(wrappers) do
		table.insert(wrapper_args, wrapper[1])
		table.insert(wrapper_args, wrapper[2])
		local content, name = positional(1 + index * 2), positional(2 + index * 2)
		table.insert(writes, `printf %s "{content}" > "$2/{name}"`)
		table.insert(chmods, `chmod +x "$2/{name}"`)
	end
	-- tar cannot detect the compression of a .tar.xz, so -J is explicit.
	-- unzip has no --strip-components option, so the Windows script unpacks
	-- into a staging directory and moves the contents of the top-level
	-- directory up.
	local extract = if plat.os == "windows"
		then 'mkdir -p "$2" "$2.stage" && unzip -q "$1" -d "$2.stage" && mv "$2.stage"/*/* "$2"'
		else 'mkdir -p "$2" && tar -xJf "$1" -C "$2" --strip-components=1'
	local script = `{extract} && {table.concat(writes, " && ")}`
	if plat.os ~= "windows" then
		script ..= ` && {table.concat(chmods, " && ")}`
	end

	local inputs = { archive = archive }
	for _, name in ipairs(install_tool_names(plat)) do
		inputs[name] = core.native_tool(name)
	end
	return core.task({
		display = `install zig {version} ({plat.os}/{plat.arch})`,
		inputs = inputs,
		outputs = { directory = output.artifact() },
		run = function(exec, resolved)
			local argv = { "sh", "-c", script, "install-zig", exec.path(resolved.archive), "zig-toolchain" }
			for _, arg in ipairs(wrapper_args) do
				table.insert(argv, arg)
			end
			local result = exec.action({
				argv = argv,
				inputs = { resolved.archive },
				outputs = {
					directory = output.directory("zig-toolchain", {
						named_cache = { name = ZIG_TOOLCHAIN_CACHE, key = key },
					}),
				},
				display = `install zig {version} ({plat.os}/{plat.arch})`,
			})
			return { directory = result.outputs.directory }
		end,
	}).outputs.directory
end

-- The tool handle of each declared version, made when the version is
-- declared, so that each caller shares one install task.
local graph_tools = {}

--- The tool handle of the managed Zig of a version, or of the default.
local function graph_tool(version)
	local resolved = ZIG.require_version(version)
	local tool = graph_tools[resolved]
	if tool == nil then
		tool = core.tool(install_directory(resolved), { name = "zig", bin_dirs = { "." } })
		graph_tools[resolved] = tool
	end
	return tool
end

-- Zig builds its runtime support code (compiler-rt, libc start files, and
-- std for `zig cc`) into $ZIG_GLOBAL_CACHE_DIR at first use. Without this
-- cache, each action has a new, empty sandbox HOME. Then each build builds
-- compiler-rt again (about 12 s), and writes a different sandbox path into
-- the debug information of that code, which -ffile-prefix-map does not
-- cover. Zig addresses the cache by what it compiles and uses lock files, so
-- a shared cache can only make builds faster or identical.
local build_cache_tools = {}

--- The tool handle of the prewarmed Zig build cache of a version. Give
--- `graph_cache_env()` to the actions that run Zig.
local function graph_build_cache_tool(version)
	local resolved = ZIG.require_version(version)
	local tool = build_cache_tools[resolved]
	if tool ~= nil then
		return tool
	end
	local plat = core.platform_info()
	local inputs = { zig = graph_tool(resolved), mkdir = core.native_tool("mkdir") }
	if plat.os == "windows" then
		inputs.sh = core.native_tool("sh")
	end
	-- The source paths are fixed, so the script needs no `dirname` tool.
	local src_dir = "zig-build-cache-prewarm"
	local script = table.concat({
		"srcdir=$1; srcfile=$2; cachedir=$3; body=$4; ",
		'mkdir -p "$srcdir" "$cachedir" && ',
		'printf %s "$body" > "$srcfile" && ',
		'ZIG_GLOBAL_CACHE_DIR="$cachedir" zig cc -g -shared -fPIC -o "$srcdir/prewarm.out" "$srcfile"',
	})
	local directory = core.task({
		display = `prewarm zig build cache {resolved} ({plat.os}/{plat.arch})`,
		inputs = inputs,
		outputs = { directory = output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = {
					"sh",
					"-c",
					script,
					"zig-build-cache-prewarm",
					src_dir,
					`{src_dir}/prewarm.c`,
					"zig-build-cache",
					"int imp_zig_build_cache_prewarm(int a, int b) { return a + b; }\n",
				},
				outputs = {
					directory = output.directory("zig-build-cache", {
						named_cache = { name = ZIG_BUILD_CACHE_CACHE, key = ZIG_BUILD_CACHE_KEY },
					}),
				},
				display = `prewarm zig build cache {resolved} ({plat.os}/{plat.arch})`,
			})
			return { directory = result.outputs.directory }
		end,
	}).outputs.directory
	tool = core.tool(directory, { name = ZIG_BUILD_CACHE_CACHE, bin_dirs = { "." } })
	build_cache_tools[resolved] = tool
	return tool
end

--- The environment that points Zig at the build cache. The action must have
--- the `build_cache_tool` of `graph_toolchain()` in its task inputs. Imp
--- mounts a tool at `.imp/tools/<name>`.
local function graph_cache_env()
	return { ZIG_GLOBAL_CACHE_DIR = `.imp/tools/{ZIG_BUILD_CACHE_CACHE}` }
end

local function append(list, values)
	for _, value in ipairs(values) do
		table.insert(list, value)
	end
	return list
end

local function quoted(values)
	local result = {}
	for _, value in ipairs(values) do
		table.insert(result, shell_quote(value))
	end
	return result
end

-- The Zig side of `commands()` of the shared contract. The `ar`, `cc`, and
-- `c++` subcommands of zig wrap clang and llvm-ar, so they read a response
-- file with the same quoting as gcc.
local function toolchain_commands()
	local windows = core.platform_info().os == "windows"
	local function compiler(is_cxx)
		return { "zig", if is_cxx then "c++" else "cc" }
	end
	return table.freeze({
		env = graph_cache_env(),
		rsp_quote = shell_quote,
		compile_command = function(args)
			local tokens = quoted(compiler(args.is_cxx))
			append(tokens, { "-c", shell_quote(args.source), "-o", shell_quote(args.obj_path) })
			append(tokens, quoted(c_toolchain.clang_opt_flags(args.opt)))
			if args.is_shared and not windows then
				table.insert(tokens, shell_quote("-fPIC"))
			end
			for _, dir in ipairs(args.include_dirs or {}) do
				table.insert(tokens, shell_quote(`-I{dir}`))
			end
			return append(tokens, quoted(args.copts or {}))
		end,
		archive_command = function(args)
			return { shell_quote("zig"), shell_quote("ar"), "rcs", shell_quote(args.out_path), `@{shell_quote(args.rsp_path)}` }
		end,
		link_command = function(args)
			local tokens = quoted(compiler(args.is_cxx))
			if args.is_shared then
				table.insert(tokens, "-shared")
			end
			append(tokens, c_toolchain.soname_args(args.out_path, args.is_shared))
			append(tokens, c_toolchain.import_lib_args(args.out_path, args.is_shared))
			append(tokens, c_toolchain.rpath_origin_args(args.bundled))
			return append(tokens, { "-o", shell_quote(args.out_path), `@{shell_quote(args.rsp_path)}` })
		end,
	})
end

local CMAKE_UNSUPPORTED_MESSAGE =
	"cmake_project() doesn't support a zig toolchain yet; pass a gcc or msvc toolchain instead"

--- The Zig provider of the shared C toolchain contract, with `tool`,
--- `build_cache_tool`, and `version`. CMake does not support a Zig
--- toolchain yet: `cmake_configure` fails, and `resolves_tool_name` is false.
local function graph_toolchain(version)
	local resolved = ZIG.require_version(version)
	local tool = graph_tool(resolved)
	local build_cache_tool = graph_build_cache_tool(resolved)
	return table.freeze({
		kind = "zig",
		tool = tool,
		build_cache_tool = build_cache_tool,
		version = resolved,
		task_inputs = function()
			return { cc_tool = tool, cc_build_cache_tool = build_cache_tool }
		end,
		commands = function()
			return toolchain_commands()
		end,
		cmake_configure = function()
			error(CMAKE_UNSUPPORTED_MESSAGE, 2)
		end,
		resolves_tool_name = function()
			return false
		end,
		resolve_state = function()
			return nil
		end,
		edge_env = function()
			return {}
		end,
	})
end

--- The Zig provider of the default version, or nil when no default is
--- declared.
local function default_graph_toolchain()
	local version = ZIG.default_version()
	return if version then graph_toolchain(version) else nil
end

--- True when `toolchain` is a Zig provider.
local function is_zig_toolchain(toolchain_value)
	return type(toolchain_value) == "table" and toolchain_value.kind == "zig"
end

--- Declare a Zig toolchain version.
---
--- Options:
---   default     Make this version the default.
---   unverified  Download without a lockfile entry, with a warning.
---   lockfile    Address of a lockfile to use instead of the shipped one,
---               for example "@workspace/locks/zig.lock".
---
--- Returns `{ version, lockfile, [GEN_LOCKFILES] }`. Export the value from a
--- BUILD module to make its lockfile root selectable by
--- `imp goal gen-lockfiles`.
local function zig_toolchain(version, options)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	-- Fail on a malformed address when the toolchain is declared, not when
	-- it is first installed.
	local ok, problem = pcall(lockfile.lockfile_address_to_path, address)
	if not ok then
		error(problem, 2)
	end
	ZIG.declare(version, {
		default = options.default,
		lockfile = address,
		unverified = options.unverified,
	})
	-- A new declaration can change the lockfile, so it declares a new
	-- install.
	graph_tools[version] = nil
	build_cache_tools[version] = nil
	graph_tool(version)
	local spec = table.clone(LOCKFILE_SPEC)
	spec.version = version
	spec.lockfile = address
	return {
		version = version,
		lockfile = address,
		[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec),
	}
end

--- Forget each declared version and the default. Tests call this, because
--- the module declares a default when it loads.
local function reset_for_test()
	ZIG.clear_default()
	graph_tools = {}
	build_cache_tools = {}
end

-- Declare the pinned default on a supported platform, so that the import
-- does not fail on another platform. A workspace can declare its own default
-- with `zig_toolchain(...)`.
if is_supported_platform(core.platform_info()) then
	zig_toolchain("0.16.0", { default = true })
end

-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("zig", function()
	return core.task({
		display = "resolve @zig",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = toolchain.bin(exec, inputs.tool, { exe = if core.platform_info().os == "windows" then "zig.exe" else "zig" }) }
		end,
	}).outputs.value
end)

return {
	ZIG = ZIG,
	artifact_name = artifact_name,
	cache_key = cache_key,
	default_graph_toolchain = default_graph_toolchain,
	default_version = ZIG.default_version,
	download_url = download_url,
	graph_build_cache_tool = graph_build_cache_tool,
	graph_cache_env = graph_cache_env,
	graph_tool = graph_tool,
	graph_toolchain = graph_toolchain,
	is_zig_toolchain = is_zig_toolchain,
	reset_for_test = reset_for_test,
	resolve_version = ZIG.resolve_version,
	supported_platforms = supported_platforms,

	--- @category configuration
	zig_toolchain = zig_toolchain,
}
