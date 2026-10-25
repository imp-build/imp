-- The MSVC toolchain of the Windows host, and the managed NASM assembler.
--
-- Imp cannot download or redistribute MSVC or the Windows SDK, so this
-- module uses the Visual Studio that the host has. Odin's default Windows
-- linker already needs the host `link.exe`. A Windows Odin build makes
-- MSVC-ABI object code. A gcc- or zig-built C or C++ dependency has a
-- different ABI and CRT, and `link.exe` rejects their COMDAT sections. A
-- dependency built with MSVC has neither problem.
--
-- `msvc_toolchain()` returns the MSVC provider of the shared C toolchain
-- contract (see `@imp/rules/c/toolchain`). One task finds the host install
-- with vswhere.exe. The provider uses the host tools where they are: its
-- `env` puts the MSVC and Windows SDK `bin` directories on PATH, and gives
-- INCLUDE and LIB.
--
-- The JavaScript module copies the host `bin` directories into named caches
-- with `cachePut`, and mounts each tool name with `msvcGraphToolSpec`. It
-- also has `nasmHostBin` with the `bin()` product for `imp @nasm`, the
-- `NASM_TOOL` product name, and `nasmGenLockfiles`. Luau has no host cache
-- write, and `nasm_toolchain()` returns the
-- lockfile root. Thus this module does not provide them.
local core = require("@imp/core")
local output = core.output
local c_toolchain = require("@imp/rules/c/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")

local shell_quote = c_toolchain.shell_quote

-- The Visual Studio Installer always puts vswhere.exe at one of these
-- paths, for each Visual Studio edition and version.
local VSWHERE_CANDIDATES = {
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
}

-- MSVC has no assembler. A CMake project that enables ASM_NASM, such as
-- BoringSSL on Windows, needs NASM. NASM publishes a Windows x86_64 build
-- only.
local NASM_CACHE = "msvc-nasm"
local NASM_VERSION = "3.02"
local NASM_PLATFORM = table.freeze({ os = "windows", arch = "x86_64" })
local DEFAULT_LOCKFILE = "@imp/rules/c/msvc/nasm.lock"

local NASM = toolchain.define("nasm")

-- The bare tool names that a replayed CMake edge can run with this
-- toolchain, after the replay removes the absolute path that CMake wrote.
-- CMake runs rc and mt without the .exe suffix.
local MSVC_GRAPH_TOOL_NAMES = table.freeze({
	["cl.exe"] = true,
	["link.exe"] = true,
	["lib.exe"] = true,
	["rc"] = true,
	["rc.exe"] = true,
	["mt"] = true,
	["mt.exe"] = true,
	["nasm"] = true,
	["nasm.exe"] = true,
})

--- The platforms that NASM publishes release archives for.
local function nasm_supported_platforms()
	return { table.clone(NASM_PLATFORM) }
end

--- The NASM release archive filename for a version and platform.
local function nasm_artifact_name(version, plat)
	if plat.os ~= "windows" or plat.arch ~= "x86_64" then
		error(`unsupported NASM platform: {plat.os}/{plat.arch} (windows/x86_64 only)`, 2)
	end
	return `nasm-{version}-win64.zip`
end

--- The NASM release download URL for a version and platform.
local function nasm_download_url(version, plat)
	return `https://www.nasm.us/pub/nasm/releasebuilds/{version}/win64/{nasm_artifact_name(version, plat)}`
end

--- The named-cache key for a NASM version. The JavaScript module uses one
--- fixed key. A Luau named cache is shared and Imp does not write an
--- existing slot again, so the key must identify the version.
local function nasm_cache_key(version)
	return `{version}/{NASM_PLATFORM.os}-{NASM_PLATFORM.arch}`
end

local LOCKFILE_SPEC = lockfiles.register_toolchain_lockfile({
	name = "nasm",
	platforms = nasm_supported_platforms(),
	download_url = nasm_download_url,
	artifact_name = nasm_artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, { NASM_VERSION })

local function resolve_nasm_version(version)
	return NASM.resolve_version(version) or NASM_VERSION
end

--- Declare the download and install of a NASM version, and return its tool
--- handle. The platform is always Windows x86_64, so that a graph built on a
--- Linux host for an MSVC target does not fail.
local function nasm_install_tool(version)
	local plat = NASM_PLATFORM
	local archive = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(NASM, version, DEFAULT_LOCKFILE),
		tool = "nasm",
		version = version,
		plat = plat,
		url = nasm_download_url(version, plat),
		output = `nasm-downloads/{version}/{nasm_artifact_name(version, plat)}`,
		display = `download nasm {version} (windows/x86_64)`,
		unverified = NASM.resolve_unverified(version),
	})
	local directory = core.task({
		display = `install nasm {version} (windows/x86_64)`,
		inputs = {
			archive = archive,
			mkdir = core.native_tool("mkdir"),
			unzip = core.native_tool("unzip"),
			mv = core.native_tool("mv"),
			sh = core.native_tool("sh"),
		},
		outputs = { directory = output.artifact() },
		run = function(exec, resolved)
			-- The zip has one top-level "nasm-<version>/" directory. unzip has
			-- no --strip-components option, so the script unpacks into a
			-- staging directory and moves its contents up.
			local result = exec.action({
				argv = {
					"sh",
					"-c",
					'mkdir -p "$2" "$2.stage" && unzip -q "$1" -d "$2.stage" && mv "$2.stage"/*/* "$2"',
					"nasm-install",
					exec.path(resolved.archive),
					"nasm-toolchain",
				},
				inputs = { resolved.archive },
				outputs = {
					directory = output.directory("nasm-toolchain", {
						named_cache = { name = NASM_CACHE, key = nasm_cache_key(version) },
					}),
				},
				display = `install nasm {version} (windows/x86_64)`,
			})
			return { directory = result.outputs.directory }
		end,
	}).outputs.directory
	return core.tool(directory, { name = "nasm", bin_dirs = { "." } })
end

-- The tool handle of each NASM version, made when the version is declared,
-- so that each caller shares one install task.
local nasm_tools = {}

--- The NASM tool handle of a version, of the default, or of the pinned
--- version.
local function nasm_graph_tool(version)
	local resolved = resolve_nasm_version(version)
	local tool = nasm_tools[resolved]
	if tool == nil then
		tool = nasm_install_tool(resolved)
		nasm_tools[resolved] = tool
	end
	return tool
end

--- Declare a NASM version. An MSVC CMake configure uses the default.
---
--- Options:
---   default     Make this version the default.
---   unverified  Download without a lockfile entry, with a warning.
---   lockfile    Address of a lockfile to use instead of the shipped one,
---               for example "@workspace/locks/nasm.lock".
---
--- Returns `{ version, lockfile, [GEN_LOCKFILES] }`. Export the value from a
--- BUILD module to make its lockfile root selectable by
--- `imp goal gen-lockfiles`.
local function nasm_toolchain(version, options)
	options = options or {}
	local resolved = version or NASM_VERSION
	local address = options.lockfile or DEFAULT_LOCKFILE
	-- Fail on a malformed address when the toolchain is declared, not when
	-- it is first installed.
	local ok, problem = pcall(lockfile.lockfile_address_to_path, address)
	if not ok then
		error(problem, 2)
	end
	NASM.declare(resolved, {
		default = options.default,
		lockfile = address,
		unverified = options.unverified,
	})
	nasm_tools[resolved] = nasm_install_tool(resolved)
	local spec = table.clone(LOCKFILE_SPEC)
	spec.version = resolved
	spec.lockfile = address
	return {
		version = resolved,
		lockfile = address,
		[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec),
	}
end

--- The absolute host path of nasm.exe. Call it in a task body. `nasm_tool`
--- is a NASM tool handle, declared as a task input.
local function resolve_nasm_host(exec, nasm_tool)
	return exec.tool_dir(nasm_tool) .. "/nasm.exe"
end

-- cl.exe /O2 /DNDEBUG or /Od /Zi. /Zi writes a separate .pdb, which no
-- caller reads now.
local function msvc_opt_flags(opt)
	if opt == "release" then
		return { "/O2", "/DNDEBUG" }
	end
	return { "/Od", "/Zi" }
end

-- The response-file reader of cl.exe, lib.exe, and link.exe uses Windows
-- command-line quoting, not shell quoting: a single-quoted token would give
-- a filename with two quote characters. The object and archive paths have no
-- double quotes, so this only wraps a value that has white space.
local function msvc_rsp_quote(value)
	local text = tostring(value)
	if string.find(text, "%s") then
		return `"{text}"`
	end
	return text
end

--- The MSVC and Windows SDK directories of a discovered host, for x86_64
--- (Hostx64/x64) only: `{ bin_dir, sdk_bin_dir, include_dirs, lib_dirs }`.
local function msvc_host_dirs(host)
	local vc_dir = `{host.vs_root}/VC/Tools/MSVC/{host.msc_version}`
	local sdk_include = `{host.sdk_root}/Include/{host.sdk_version}`
	local sdk_lib = `{host.sdk_root}/Lib/{host.sdk_version}`
	return {
		bin_dir = `{vc_dir}/bin/Hostx64/x64`,
		sdk_bin_dir = `{host.sdk_root}/bin/{host.sdk_version}/x64`,
		include_dirs = {
			`{vc_dir}/include`,
			`{sdk_include}/ucrt`,
			`{sdk_include}/um`,
			`{sdk_include}/shared`,
		},
		lib_dirs = { `{vc_dir}/lib/x64`, `{sdk_lib}/ucrt/x64`, `{sdk_lib}/um/x64` },
	}
end

--- The action environment of a discovered host.
---
--- PATH has the MSVC and Windows SDK `bin` directories, so that cl.exe,
--- link.exe, lib.exe, rc.exe, and mt.exe run where the host installed them.
--- Imp adds the `bin` directories of the declared tools before this PATH.
---
--- INCLUDE and LIB are the variables that vcvarsall.bat sets. They are not
--- /I and /LIBPATH flags, because a CMake replay runs each edge through
--- `sh -c`, and the replay removes the double quotes of a command, which
--- breaks a path such as "Program Files (x86)". An environment value is not
--- tokenized.
---
--- MSYS2_ARG_CONV_EXCL=* stops the MSYS runtime of Git for Windows from
--- changing a token that looks like a POSIX path before it starts a native
--- program. Without it, a flag such as `/FoCMakeFiles/foo.dir/x.obj` changes,
--- and cl.exe writes the object to the wrong path.
local function msvc_env(host)
	local dirs = msvc_host_dirs(host)
	return {
		PATH = `{dirs.bin_dir};{dirs.sdk_bin_dir}`,
		INCLUDE = table.concat(dirs.include_dirs, ";"),
		LIB = table.concat(dirs.lib_dirs, ";"),
		MSYS2_ARG_CONV_EXCL = "*",
	}
end

--- The CMake arguments that select a discovered MSVC host: the compiler,
--- RC, MT, and NASM paths. CMake selects lib.exe and its MSVC archive rule
--- from cl.exe. The Ninja generator does not find rc and mt itself.
---
--- CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON gives the default of GNU ld, which
--- exports each global symbol. MSVC exports nothing without dllexport or a
--- .def file, and then writes no import library. C and C++ dependencies
--- built for gcc usually have no dllexport annotations.
local function msvc_cmake_compiler_args(host, nasm_path)
	local dirs = msvc_host_dirs(host)
	local cl_path = `{dirs.bin_dir}/cl.exe`
	return {
		`-DCMAKE_C_COMPILER={cl_path}`,
		`-DCMAKE_CXX_COMPILER={cl_path}`,
		`-DCMAKE_RC_COMPILER={dirs.sdk_bin_dir}/rc.exe`,
		`-DCMAKE_MT={dirs.sdk_bin_dir}/mt.exe`,
		`-DCMAKE_ASM_NASM_COMPILER={nasm_path}`,
		"-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON",
	}
end

local DISCOVER_SCRIPT = table.concat({
	'vswhere=""; ',
	'for c in "$@"; do ',
	'if [ -f "$c" ]; then vswhere=$c; break; fi; ',
	"done; ",
	'if [ -z "$vswhere" ]; then echo "no vswhere.exe found at any known install path" >&2; exit 1; fi; ',
	'vsroot=$("$vswhere" -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath); ',
	'if [ -z "$vsroot" ]; then echo "vswhere found no MSVC (VC.Tools.x86.x64) install on this host" >&2; exit 1; fi; ',
	'mscver=$(tr -d "\\r\\n" < "$vsroot/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"); ',
	'sdkroot="C:/Program Files (x86)/Windows Kits/10"; ',
	'sdkver=$(ls "$sdkroot/Include" | sort -V | tail -1); ',
	'printf "%s\\n%s\\n%s\\n%s\\n" "$vsroot" "$mscver" "$sdkroot" "$sdkver"',
})

local function trim(text)
	return (string.gsub(text, "^%s*(.-)%s*$", "%1"))
end

--- Parse the four lines that the discovery script prints into the host
--- record `{ vs_root, msc_version, sdk_root, sdk_version }`.
local function parse_msvc_host(stdout)
	local lines = {}
	for line in string.gmatch(trim(stdout) .. "\n", "([^\n]*)\n") do
		table.insert(lines, trim(line))
	end
	local host = {
		vs_root = lines[1],
		msc_version = lines[2],
		sdk_root = lines[3],
		sdk_version = lines[4],
	}
	for _, field in ipairs({ "vs_root", "msc_version", "sdk_root", "sdk_version" }) do
		if host[field] == nil or host[field] == "" then
			error(
				`failed to discover a host MSVC toolchain (got vs_root={host.vs_root}, msc_version={host.msc_version}, sdk_root={host.sdk_root}, sdk_version={host.sdk_version}); is Visual Studio (with the "Desktop development with C++" workload) installed?`,
				2
			)
		end
	end
	return host
end

-- The one discovery task that each MSVC consumer shares, so that vswhere
-- runs one time in a build and not one time for each source file. Its action
-- does not cache, so that the next build finds a changed Visual Studio
-- install. `core.task` keeps a task result in memory for one build only.
-- A fingerprint of the host install, such as the instance ID, could make it
-- a cached task.
local host_task = nil

local function msvc_host_output()
	if host_task == nil then
		local argv = { "sh", "-c", DISCOVER_SCRIPT, "msvc-discover" }
		for _, candidate in ipairs(VSWHERE_CANDIDATES) do
			table.insert(argv, candidate)
		end
		host_task = core.task({
			display = "discover MSVC host toolchain",
			outputs = { host = output.value() },
			run = function(exec)
				local result = exec.action({
					argv = argv,
					cache = false,
					display = "discover MSVC host toolchain",
				})
				return { host = parse_msvc_host(result.stdout) }
			end,
		})
	end
	return host_task.outputs.host
end

local function append(list, values)
	for _, value in ipairs(values) do
		table.insert(list, value)
	end
	return list
end

-- The MSVC side of `commands()` of the shared contract: cl.exe and lib.exe
-- forms of the compile, archive, and link shapes. cl.exe is also the link
-- driver, as gcc is, because it finds the CRT startup objects and the
-- default libraries. /LD is the cl.exe form of -shared.
local function toolchain_commands(host)
	return table.freeze({
		env = msvc_env(host),
		rsp_quote = msvc_rsp_quote,
		compile_command = function(args)
			local tokens = { "cl.exe", "/nologo", "/c", if args.is_cxx then "/TP" else "/TC" }
			append(tokens, msvc_opt_flags(args.opt))
			for _, dir in ipairs(args.include_dirs or {}) do
				table.insert(tokens, shell_quote(`/I{dir}`))
			end
			for _, copt in ipairs(args.copts or {}) do
				table.insert(tokens, shell_quote(copt))
			end
			table.insert(tokens, shell_quote(`/Fo{args.obj_path}`))
			table.insert(tokens, shell_quote(args.source))
			return tokens
		end,
		archive_command = function(args)
			return { "lib.exe", "/nologo", shell_quote(`/OUT:{args.out_path}`), `@{shell_quote(args.rsp_path)}` }
		end,
		link_command = function(args)
			local tokens = { "cl.exe", "/nologo" }
			if args.is_shared then
				table.insert(tokens, "/LD")
			end
			return append(tokens, { shell_quote(`/Fe{args.out_path}`), `@{shell_quote(args.rsp_path)}` })
		end,
	})
end

--- The MSVC provider of the shared C toolchain contract. It has no version:
--- it uses the Visual Studio that the host has. The table is inert. Only a
--- task that declares `task_inputs()` runs the discovery task.
local function msvc_toolchain()
	return table.freeze({
		kind = "msvc-host-toolchain",
		version = nil,
		task_inputs = function()
			local inputs = { msvc_host = msvc_host_output() }
			-- NASM is for Windows only. Off Windows, it would only add graph
			-- nodes that nothing uses.
			if core.platform_info().os == "windows" then
				inputs.nasm = nasm_graph_tool()
			end
			return inputs
		end,
		commands = function(_exec, inputs)
			return toolchain_commands(inputs.msvc_host)
		end,
		cmake_configure = function(exec, inputs)
			if inputs.nasm == nil then
				error("msvc_toolchain() CMake configure runs on a Windows host only", 2)
			end
			local host = inputs.msvc_host
			return {
				compiler_args = msvc_cmake_compiler_args(host, resolve_nasm_host(exec, inputs.nasm)),
				env = msvc_env(host),
			}
		end,
		resolves_tool_name = function(name)
			return MSVC_GRAPH_TOOL_NAMES[name] == true
		end,
		resolve_state = function(_exec, inputs)
			return inputs.msvc_host
		end,
		edge_env = function(host)
			return msvc_env(host)
		end,
	})
end

--- True when `toolchain` is an MSVC provider.
local function is_msvc_toolchain(toolchain_value)
	return type(toolchain_value) == "table" and toolchain_value.kind == "msvc-host-toolchain"
end

--- Forget the discovery task, each declared NASM version, and the default.
--- Tests call this, because the module declares a default when it loads on
--- Windows.
local function reset_for_test()
	NASM.clear_default()
	nasm_tools = {}
	host_task = nil
end

-- Declare the pinned NASM default on Windows only. NASM has no other
-- platform, and an import on another platform must not declare an install.
if core.platform_info().os == "windows" then
	nasm_toolchain(NASM_VERSION, { default = true })
end

-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("nasm", function()
	return core.task({
		display = "resolve @nasm",
		inputs = { tool = nasm_graph_tool(NASM.require_version()) },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return { value = toolchain.bin(exec, inputs.tool, { exe = "nasm.exe" }) }
		end,
	}).outputs.value
end)

return {
	MSVC_GRAPH_TOOL_NAMES = MSVC_GRAPH_TOOL_NAMES,
	NASM = NASM,
	is_msvc_toolchain = is_msvc_toolchain,
	msvc_cmake_compiler_args = msvc_cmake_compiler_args,
	msvc_env = msvc_env,
	msvc_host_dirs = msvc_host_dirs,
	msvc_toolchain = msvc_toolchain,
	nasm_artifact_name = nasm_artifact_name,
	nasm_cache_key = nasm_cache_key,
	nasm_download_url = nasm_download_url,
	nasm_graph_tool = nasm_graph_tool,
	nasm_supported_platforms = nasm_supported_platforms,

	--- @category configuration
	nasm_toolchain = nasm_toolchain,
	parse_msvc_host = parse_msvc_host,
	reset_for_test = reset_for_test,
	resolve_nasm_host = resolve_nasm_host,
}
