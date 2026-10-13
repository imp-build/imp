-- The managed gcc toolchain: a Bootlin cross-toolchain on Linux, and a
-- WinLibs mingw-w64 build on Windows.
--
-- `gcc_toolchain(version, options)` declares a version. The module declares
-- the pinned default when it loads on a supported platform.
-- `graph_toolchain(version)` returns the gcc provider of the shared C
-- toolchain contract (see `@imp/rules/c/toolchain`), with `tool` and
-- `version`. `tool` is a `core.tool()` handle whose `bin` directory has the
-- `clang`, `cc`, `c++`, `ar`, and `ranlib` names, and on Windows `nasm`.
--
-- The JavaScript module also has `installGccToolchain` (a local directory
-- into the named cache), `gccTool` (a legacy `run({ tools })` entry),
-- `gccBin` with the `bin()` product for `imp @tool`, the `GCC_TOOL` product
-- name, and `gccGraphToolSpec` (a mount for each tool name of a replayed
-- CMake edge). Luau has no host cache write and no `imp @tool` dispatch, and
-- the tool handle replaces the `run` entry and the mounts. Thus this module
-- does not provide them. The functions that need the absolute install
-- directory take the task `exec` and the tool handle, and read the directory
-- with `exec.tool_dir`.
local core = require("@imp/core")
local output = core.output
local c_toolchain = require("@imp/rules/c/toolchain")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")

local shell_quote = c_toolchain.shell_quote

local GCC_TOOLCHAIN_CACHE = "gcc-toolchains"
local DEFAULT_LOCKFILE = "@imp/rules/c/gcc/gcc.lock"
local WINDOWS_DEFAULT_LOCKFILE = "@imp/rules/c/gcc/gcc-windows.lock"

local GCC = toolchain.define("gcc")

-- The bare tool names that a replayed CMake edge can run with this
-- toolchain, after the replay removes the absolute path that
-- `cmake_compiler_args` gave CMake. The `-unsafe-paths` names come from the
-- `unsafe_system_paths` option. CMake keeps the `.exe` suffix of a Windows
-- path, so the Windows names have their own entries. nasm is not a compiler
-- alias, but WinLibs ships it in the same `bin` directory, and BoringSSL's
-- Windows build gives its absolute path to CMake.
local GCC_GRAPH_TOOL_NAMES = table.freeze({
	["clang"] = true,
	["cc"] = true,
	["c++"] = true,
	["ar"] = true,
	["ranlib"] = true,
	["nasm"] = true,
	["clang-unsafe-paths"] = true,
	["cc-unsafe-paths"] = true,
	["c++-unsafe-paths"] = true,
	["clang.exe"] = true,
	["cc.exe"] = true,
	["c++.exe"] = true,
	["ar.exe"] = true,
	["ranlib.exe"] = true,
	["nasm.exe"] = true,
	["clang-unsafe-paths.exe"] = true,
	["cc-unsafe-paths.exe"] = true,
	["c++-unsafe-paths.exe"] = true,
})

-- Bootlin's arch name (for example "x86-64", not "x86_64"), the short
-- prefix of the gcc aliases of the toolchain (for example "x86_64-linux-gcc"),
-- and the full buildroot prefix of its binutils, which have no short alias
-- (for example "x86_64-buildroot-linux-gnu-ar").
local BOOTLIN_ARCH = { x86_64 = "x86-64" }
local GCC_EXE_PREFIX = { x86_64 = "x86_64-linux" }
local BINUTILS_PREFIX = { x86_64 = "x86_64-buildroot-linux-gnu" }

-- Linux downloads a Bootlin toolchain and Windows downloads a WinLibs build.
-- The two vendors have different version schemes.
local function require_supported_platform(plat)
	if plat.os ~= "linux" and plat.os ~= "windows" then
		error(`unsupported gcc toolchain OS: {plat.os}`, 3)
	end
	if plat.arch ~= "x86_64" then
		error(`unsupported gcc toolchain architecture: {plat.arch}`, 3)
	end
end

local function is_supported_platform(plat)
	return (plat.os == "linux" or plat.os == "windows") and plat.arch == "x86_64"
end

-- WinLibs (winlibs.com) publishes self-contained mingw-w64 GCC builds (UCRT
-- runtime, POSIX threads, SEH exceptions, x86_64) as GitHub release assets.
-- The release tag packs three versions: GCC, the mingw-w64 runtime, and the
-- WinLibs build revision. For example, tag "16.1.0posix-14.0.0-ucrt-r4"
-- downloads "winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip".
-- No formula gives the tag from a GCC version, so a Windows gcc version is
-- the tag.
local WINLIBS_TAG_PATTERN = "^(%d+%.%d+%.%d+)posix%-(%d+%.%d+%.%d+)%-ucrt%-r(%d+)$"

local function parse_winlibs_tag(version)
	local gcc_version, mingw_version, revision = string.match(version, WINLIBS_TAG_PATTERN)
	if gcc_version == nil then
		error(
			`gcc toolchain version '{version}' doesn't look like a WinLibs release tag (expected e.g. "16.1.0posix-14.0.0-ucrt-r4")`,
			3
		)
	end
	return gcc_version, mingw_version, revision
end

local function winlibs_artifact_name(version)
	local gcc_version, mingw_version, revision = parse_winlibs_tag(version)
	return `winlibs-x86_64-posix-seh-gcc-{gcc_version}-mingw-w64ucrt-{mingw_version}-r{revision}.zip`
end

--- The toolchain archive filename for a version and platform: a Bootlin
--- tarball on Linux, and a WinLibs zip on Windows.
local function artifact_name(version, plat)
	require_supported_platform(plat)
	if plat.os == "windows" then
		return winlibs_artifact_name(version)
	end
	return `{BOOTLIN_ARCH[plat.arch]}--glibc--stable-{version}.tar.xz`
end

--- The toolchain download URL for a version and platform.
local function download_url(version, plat)
	require_supported_platform(plat)
	if plat.os == "windows" then
		return `https://github.com/brechtsanders/winlibs_mingw/releases/download/{version}/{winlibs_artifact_name(version)}`
	end
	local arch = BOOTLIN_ARCH[plat.arch]
	return `https://toolchains.bootlin.com/downloads/releases/toolchains/{arch}/tarballs/{artifact_name(version, plat)}`
end

--- The platforms that Bootlin publishes a gcc toolchain for: Linux, with
--- each arch of `BOOTLIN_ARCH`.
local function supported_platforms()
	local platforms = {}
	for arch in pairs(BOOTLIN_ARCH) do
		table.insert(platforms, { os = "linux", arch = arch })
	end
	return platforms
end

--- The named-cache key for a gcc version and platform.
local function cache_key(version, plat)
	return `{version}/{plat.os}-{plat.arch}`
end

--- The plain GCC version in a WinLibs release tag, for example "16.1.0"
--- for "16.1.0posix-14.0.0-ucrt-r4". The WinLibs archive keeps its runtime
--- libraries under `lib/gcc/x86_64-w64-mingw32/<gcc version>/`.
local function winlibs_gcc_version(version)
	return (parse_winlibs_tag(version))
end

local LOCKFILE_SPEC_LINUX = lockfiles.register_toolchain_lockfile({
	name = "gcc",
	platforms = supported_platforms(),
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, { "2025.08-1", "2026.08-1" })

-- The WinLibs tag shares no version scheme with Bootlin. A registered
-- lockfile resolves one version string with one formula on each of its
-- platforms, so Windows has its own lockfile and version list.
local LOCKFILE_SPEC_WINDOWS = lockfiles.register_toolchain_lockfile({
	name = "gcc-windows",
	platforms = { { os = "windows", arch = "x86_64" } },
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = WINDOWS_DEFAULT_LOCKFILE,
}, { "16.1.0posix-14.0.0-ucrt-r4", "16.2.0posix-14.0.0-ucrt-r1" })

local function default_lockfile(plat)
	return if plat.os == "windows" then WINDOWS_DEFAULT_LOCKFILE else DEFAULT_LOCKFILE
end

-- The Linux install script. Bootlin's gcc binary is a `toolchain-wrapper`
-- that reads argv[0], so each alias is a script that runs the real binary by
-- its own name: clang and cc run gcc, c++ runs g++, and ar and ranlib run
-- the binutils programs, which have a different prefix. rustc links with
-- "clang", cc-rs build scripts need "ar", and CMake replay needs "ranlib".
--
-- The "-unsafe-paths" aliases run the `.br_real` binary directly, with the
-- --sysroot and hardening flags that the wrapper adds (captured with
-- BR2_DEBUG_WRAPPER=1). The wrapper rejects each -I, -isystem, -idirafter,
-- -iquote, or -L argument under /usr/include or /usr/lib, which blocks a
-- link against a system package such as libwebkit2gtk-4.1. A target with
-- `unsafe_system_paths` uses these aliases.
--
-- "bin-unsafe-paths/" has the same aliases under the plain names, because
-- Odin runs a program named "clang" through PATH. These are scripts and not
-- symbolic links: a script resolves "${0%/*}" from the path that started it,
-- so a link in "bin-unsafe-paths/" would not find the `.br_real` binary.
local LINUX_INSTALL_SCRIPT = table.concat({
	[[archive=$1; out=$2; gccPrefix=$3; binutilsPrefix=$4; ]],
	[[mkdir -p "$out" && tar -xJf "$archive" -C "$out" --strip-components=1 && ]],
	[[for pair in "clang:$gccPrefix-gcc" "cc:$gccPrefix-gcc" "c++:$gccPrefix-g++" "ar:$binutilsPrefix-ar" "ranlib:$binutilsPrefix-ranlib"; do ]],
	[[name=${pair%%:*}; target=${pair#*:}; ]],
	[[printf '%s\n' '#!/bin/sh' "exec \"\${0%/*}/$target\" \"\$@\"" > "$out/bin/$name"; chmod +x "$out/bin/$name"; done && ]],
	[[for pair in "clang-unsafe-paths:$binutilsPrefix-gcc.br_real" "cc-unsafe-paths:$binutilsPrefix-gcc.br_real" "c++-unsafe-paths:$binutilsPrefix-g++.br_real"; do ]],
	[[name=${pair%%:*}; target=${pair#*:}; ]],
	[[printf '%s\n' '#!/bin/sh' "exec \"\${0%/*}/$target\" --sysroot \"\${0%/*}/../$binutilsPrefix/sysroot\" -fstack-protector-strong -fPIE -pie -Wl,-z,now -Wl,-z,relro \"\$@\"" > "$out/bin/$name"; chmod +x "$out/bin/$name"; done && ]],
	[[mkdir -p "$out/bin-unsafe-paths" && ]],
	[[for pair in "clang:$binutilsPrefix-gcc.br_real" "cc:$binutilsPrefix-gcc.br_real" "c++:$binutilsPrefix-g++.br_real"; do ]],
	[[name=${pair%%:*}; target=${pair#*:}; ]],
	[[printf '%s\n' '#!/bin/sh' "exec \"\${0%/*}/../bin/$target\" --sysroot \"\${0%/*}/../$binutilsPrefix/sysroot\" -fstack-protector-strong -fPIE -pie -Wl,-z,now -Wl,-z,relro \"\$@\"" > "$out/bin-unsafe-paths/$name"; chmod +x "$out/bin-unsafe-paths/$name"; done && ]],
	[[for pair in "ar:$binutilsPrefix-ar" "ranlib:$binutilsPrefix-ranlib"; do ]],
	[[name=${pair%%:*}; target=${pair#*:}; ]],
	[[printf '%s\n' '#!/bin/sh' "exec \"\${0%/*}/../bin/$target\" \"\$@\"" > "$out/bin-unsafe-paths/$name"; chmod +x "$out/bin-unsafe-paths/$name"; done]],
})

-- The Windows install script. The WinLibs zip has no toolchain-wrapper,
-- sysroot, or path guard, so each alias is a copy of the real binary:
-- clang and cc are gcc.exe. ar.exe, ranlib.exe, and c++.exe already have
-- their plain names. The "-unsafe-paths" aliases and "bin-unsafe-paths/" are
-- plain copies too, so `unsafe_system_paths` has no effect on Windows.
--
-- unzip extracts the zip, not tar: a Windows host can have the tar of Git
-- for Windows, which cannot read zip, and bsdtar, and the PATH order selects
-- one. unzip has no --strip-components option, so the script unpacks into a
-- staging directory and moves the contents of its "mingw64/" directory up.
--
-- lld-link (Odin's `-linker:lld`) cannot do the auto-import of GNU ld. It
-- needs an import-library thunk for each DLL symbol. No WinLibs archive has
-- `atexit` as a static or import symbol. GNU ld finds it in the export table
-- of msvcrt.dll. dlltool makes the same thunk as an import library that
-- lld-link reads, and `windows_runtime_archives` links it.
local WINDOWS_INSTALL_SCRIPT = table.concat({
	[[archive=$1; out=$2; ]],
	[[mkdir -p "$out/bin" "$out/bin-unsafe-paths" "$out.stage" && ]],
	[[unzip -q "$archive" -d "$out.stage" && ]],
	[[mv "$out.stage"/*/* "$out"/ && ]],
	[[for pair in "clang:gcc" "cc:gcc" "clang-unsafe-paths:gcc" "cc-unsafe-paths:gcc" "c++-unsafe-paths:c++"; do ]],
	[[name=${pair%%:*}; target=${pair#*:}; ]],
	[[cp "$out/bin/$target.exe" "$out/bin/$name.exe"; ]],
	[[done && ]],
	[[for name in clang cc c++ ar ranlib; do ]],
	[[cp "$out/bin/$name.exe" "$out/bin-unsafe-paths/$name.exe"; ]],
	[[done && ]],
	[[mkdir -p "$out/x86_64-w64-mingw32/lib" && ]],
	[[printf "LIBRARY msvcrt.dll\nEXPORTS\natexit\n" > "$out/msvcrt-shim.def" && ]],
	[["$out/bin/dlltool.exe" -d "$out/msvcrt-shim.def" -l "$out/x86_64-w64-mingw32/lib/libmsvcrt_shim.a" -D msvcrt.dll -m i386:x86-64]],
})

--- Declare the download and install of a gcc version, and return the
--- artifact handle of the installed tree.
local function install_directory(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local windows = plat.os == "windows"
	local archive = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(GCC, version, default_lockfile(plat)),
		tool = if windows then "gcc-windows" else "gcc",
		version = version,
		plat = plat,
		url = download_url(version, plat),
		output = `gcc-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download gcc {version} ({plat.os}/{plat.arch})`,
		unverified = GCC.resolve_unverified(version),
	})
	local inputs = { archive = archive, sh = core.native_tool("sh"), mkdir = core.native_tool("mkdir") }
	if windows then
		inputs.cp = core.native_tool("cp")
		inputs.mv = core.native_tool("mv")
		inputs.unzip = core.native_tool("unzip")
	else
		inputs.tar = core.native_tool("tar")
		inputs.xz = core.native_tool("xz")
		inputs.chmod = core.native_tool("chmod")
	end
	return core.task({
		display = `install gcc {version} ({plat.os}/{plat.arch})`,
		inputs = inputs,
		outputs = { directory = output.artifact() },
		run = function(exec, resolved)
			local argv
			if windows then
				argv = { "sh", "-c", WINDOWS_INSTALL_SCRIPT, "gcc-install", exec.path(resolved.archive), "gcc-toolchain" }
			else
				argv = {
					"sh",
					"-c",
					LINUX_INSTALL_SCRIPT,
					"gcc-install",
					exec.path(resolved.archive),
					"gcc-toolchain",
					GCC_EXE_PREFIX[plat.arch],
					BINUTILS_PREFIX[plat.arch],
				}
			end
			local result = exec.action({
				argv = argv,
				inputs = { resolved.archive },
				outputs = {
					directory = output.directory("gcc-toolchain", {
						named_cache = { name = GCC_TOOLCHAIN_CACHE, key = key },
					}),
				},
				display = `install gcc {version} ({plat.os}/{plat.arch})`,
			})
			return { directory = result.outputs.directory }
		end,
	}).outputs.directory
end

-- The installed tree of each declared version, made when the version is
-- declared, so that each caller shares one install task.
local install_directories = {}

local function install_directory_for(version)
	local directory = install_directories[version]
	if directory == nil then
		directory = install_directory(version)
		install_directories[version] = directory
	end
	return directory
end

--- The tool handle of the managed gcc of a version.
---
--- Options:
---   unsafe_system_paths  Put "bin-unsafe-paths" on PATH in place of
---                        "bin", so that the plain names skip Bootlin's
---                        path guard.
local function graph_tool(version, options)
	local resolved = GCC.require_version(version)
	options = options or {}
	-- A task fails when two of its tool inputs have the same name, so the
	-- two handles have different names.
	if options.unsafe_system_paths then
		return core.tool(
			install_directory_for(resolved),
			{ name = "gcc-toolchain-unsafe-paths", bin_dirs = { "bin-unsafe-paths" } }
		)
	end
	return core.tool(install_directory_for(resolved), { name = "gcc-toolchain", bin_dirs = { "bin" } })
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

-- The gcc side of `commands()` of the shared contract. The compile, archive,
-- and link tokens go into an `sh -c` script. The tool handle puts the
-- aliases on PATH, so the commands use their bare names.
--
-- On Windows, -pipe prevents a failure of the MSYS runtime of Git for
-- Windows. It removes TMP and TEMP when it starts a native child, so cc1 and
-- as fail with "Cannot create temporary file". -pipe connects the compile
-- stages with a pipe instead of temporary files.
local function toolchain_commands(options)
	options = options or {}
	local suffix = if options.unsafe_system_paths then "-unsafe-paths" else ""
	local windows = core.platform_info().os == "windows"
	local function compiler(is_cxx)
		local name = if is_cxx then `c++{suffix}` else `clang{suffix}`
		local tokens = { name }
		if windows then
			table.insert(tokens, "-pipe")
		end
		return tokens
	end
	return table.freeze({
		env = {},
		-- GNU ar and ld read a response file with shell-like quoting.
		rsp_quote = shell_quote,
		compile_command = function(args)
			local tokens = quoted(compiler(args.is_cxx))
			append(tokens, { "-c", shell_quote(args.source), "-o", shell_quote(args.obj_path) })
			append(tokens, quoted(c_toolchain.clang_opt_flags(args.opt)))
			-- Shared-object code needs -fPIC on ELF platforms. MinGW ignores
			-- it, because all Windows code is position-independent.
			if args.is_shared and not windows then
				table.insert(tokens, shell_quote("-fPIC"))
			end
			for _, dir in ipairs(args.include_dirs or {}) do
				table.insert(tokens, shell_quote(`-I{dir}`))
			end
			return append(tokens, quoted(args.copts or {}))
		end,
		archive_command = function(args)
			return { shell_quote("ar"), "rcs", shell_quote(args.out_path), `@{shell_quote(args.rsp_path)}` }
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

--- The absolute host directory of an installed gcc. Call it in a task body.
--- `gcc_tool` is the `tool` of `graph_toolchain()`, declared as a task input.
local function graph_toolchain_dir(exec, gcc_tool)
	return exec.tool_dir(gcc_tool)
end

local function exe_suffix()
	return if core.platform_info().os == "windows" then ".exe" else ""
end

--- The CMake arguments that select this gcc: CMAKE_C_COMPILER,
--- CMAKE_CXX_COMPILER, CMAKE_RANLIB, CMAKE_AR, and on Windows
--- CMAKE_ASM_NASM_COMPILER.
---
--- The paths are absolute host paths. CMake writes them into build.ninja, and
--- later replay actions read build.ninja in other sandboxes. CMAKE_RANLIB is
--- necessary: without it, CMake finds the ranlib of the host and writes its
--- path. WinLibs ships nasm.exe in `bin`. Without the nasm argument, CMake
--- searches the host PATH for `enable_language(ASM_NASM)`, and a BoringSSL
--- build can silently omit its assembly routines.
---
--- `unsafe_system_paths` selects the "-unsafe-paths" compilers. ar and
--- ranlib have no wrapper, so they do not change.
local function cmake_compiler_args(exec, gcc_tool, unsafe_system_paths)
	local dir = graph_toolchain_dir(exec, gcc_tool)
	local suffix = if unsafe_system_paths then "-unsafe-paths" else ""
	local exe = exe_suffix()
	local args = {
		`-DCMAKE_C_COMPILER={dir}/bin/clang{suffix}{exe}`,
		`-DCMAKE_CXX_COMPILER={dir}/bin/c++{suffix}{exe}`,
		`-DCMAKE_RANLIB={dir}/bin/ranlib{exe}`,
		`-DCMAKE_AR={dir}/bin/ar{exe}`,
	}
	if core.platform_info().os == "windows" then
		table.insert(args, `-DCMAKE_ASM_NASM_COMPILER={dir}/bin/nasm{exe}`)
	end
	return args
end

--- The absolute paths of the mingw-w64 runtime archives that a COFF linker,
--- such as lld-link, needs. A gcc front end adds them through its default
--- library spec. Odin's `-linker:lld` link on Windows fails without them,
--- with undefined UCRT symbols and C++ symbols such as
--- `__gxx_personality_seh0`, `_Unwind_Resume`, and `operator new`.
---
--- `version` is the WinLibs tag of the installed toolchain.
local function windows_runtime_archives(exec, gcc_tool, version)
	local dir = graph_toolchain_dir(exec, gcc_tool)
	local gcc_version = winlibs_gcc_version(version)
	return {
		`{dir}/lib/gcc/x86_64-w64-mingw32/{gcc_version}/libgcc.a`,
		`{dir}/lib/gcc/x86_64-w64-mingw32/{gcc_version}/libgcc_eh.a`,
		`{dir}/x86_64-w64-mingw32/lib/libmingwex.a`,
		`{dir}/x86_64-w64-mingw32/lib/libmingw32.a`,
		`{dir}/x86_64-w64-mingw32/lib/libucrt.a`,
		`{dir}/x86_64-w64-mingw32/lib/libwinpthread.a`,
		`{dir}/lib/libstdc++.a`,
		`{dir}/lib/libsupc++.a`,
		-- The libstdc++.a of this "ucrt" WinLibs build calls msvcrt.dll
		-- symbols, such as atexit, that libucrt.a does not have. Only the
		-- libws2_32.a of mingw defines gai_strerrorA out of line, which
		-- BoringSSL calls.
		`{dir}/x86_64-w64-mingw32/lib/libmsvcrt.a`,
		`{dir}/x86_64-w64-mingw32/lib/libws2_32.a`,
		-- The dlltool import stub for atexit. See WINDOWS_INSTALL_SCRIPT.
		`{dir}/x86_64-w64-mingw32/lib/libmsvcrt_shim.a`,
	}
end

--- The rustflags, environment, and PATH directories that make rustc and
--- cc-rs use this gcc. Call it in a task body. `gcc_tool` is the `tool` of
--- `graph_toolchain()`, declared as a task input.
---
--- Returns `{ rustflags, env, path_dirs }`. The paths are absolute: Cargo can
--- start rustc in a package or build-script directory, so a
--- sandbox-relative linker path is not stable. `path_dirs` has the `bin`
--- directory, because cc-rs build scripts find "ar" through PATH. With
--- `kache_active`, CC and CXX run the compiler through kache.
local function rust_link_driver_env(exec, gcc_tool, kache_active)
	local dir = graph_toolchain_dir(exec, gcc_tool)
	local exe = exe_suffix()
	local clang_path = `{dir}/bin/clang{exe}`
	local cxx_path = `{dir}/bin/c++{exe}`
	local result = {
		rustflags = { "-C", `linker={clang_path}` },
		path_dirs = { `{dir}/bin` },
	}
	if kache_active then
		result.env = { CC = `kache {clang_path}`, CXX = `kache {cxx_path}` }
	else
		result.env = { CC = clang_path }
	end
	return result
end

--- The gcc provider of the shared C toolchain contract for a tool handle and
--- a version. A test can give a fake tool handle.
local function toolchain_record(tool, version)
	return table.freeze({
		kind = "gcc",
		tool = tool,
		version = version,
		task_inputs = function()
			return { cc_tool = tool }
		end,
		commands = function(_exec, _inputs, options)
			return toolchain_commands(options)
		end,
		cmake_configure = function(exec, inputs, options)
			local unsafe = options ~= nil and options.unsafe_system_paths
			return { compiler_args = cmake_compiler_args(exec, inputs.cc_tool, unsafe), env = {} }
		end,
		resolves_tool_name = function(name)
			return GCC_GRAPH_TOOL_NAMES[name] == true
		end,
		resolve_state = function()
			return nil
		end,
		edge_env = function()
			return {}
		end,
	})
end

--- The gcc provider of a version, or of the default.
local function graph_toolchain(version)
	local resolved = GCC.require_version(version)
	return toolchain_record(graph_tool(resolved), resolved)
end

--- The gcc provider of the default version, or nil when no default is
--- declared.
local function default_graph_toolchain()
	local version = GCC.default_version()
	return if version then graph_toolchain(version) else nil
end

--- True when `toolchain` is a gcc provider.
local function is_gcc_toolchain(toolchain_value)
	return type(toolchain_value) == "table" and toolchain_value.kind == "gcc"
end

local function for_platform(value, plat)
	if type(value) == "table" then
		return value[plat.os]
	end
	return value
end

--- Declare a gcc toolchain version.
---
--- `version` is a Bootlin version on Linux (for example "2025.08-1") and a
--- WinLibs tag on Windows (for example "16.1.0posix-14.0.0-ucrt-r4"). A
--- string applies to the host platform. A table such as
--- `{ linux = "...", windows = "..." }` gives one version for each OS.
---
--- Options:
---   default     Make this version the default.
---   unverified  Download without a lockfile entry, with a warning.
---   lockfile    Address of a lockfile to use instead of the shipped one, for
---               example "@workspace/locks/gcc.lock". A table keyed by OS
---               gives one address for each OS.
---
--- Returns `{ version, lockfile, [GEN_LOCKFILES] }`. Export the value from a
--- BUILD module to make its lockfile root selectable by
--- `imp goal gen-lockfiles`.
local function gcc_toolchain(version, options)
	options = options or {}
	local plat = core.platform_info()
	local resolved = for_platform(version, plat)
	if resolved == nil then
		error(`gcc toolchain version has no entry for platform '{plat.os}'`, 2)
	end
	local address = for_platform(options.lockfile, plat) or default_lockfile(plat)
	-- Fail on a malformed address when the toolchain is declared, not when
	-- it is first installed.
	local ok, problem = pcall(lockfile.lockfile_address_to_path, address)
	if not ok then
		error(problem, 2)
	end
	GCC.declare(resolved, {
		default = options.default,
		lockfile = address,
		unverified = options.unverified,
	})
	install_directories[resolved] = install_directory(resolved)
	local spec = table.clone(if plat.os == "windows" then LOCKFILE_SPEC_WINDOWS else LOCKFILE_SPEC_LINUX)
	spec.version = resolved
	spec.lockfile = address
	return {
		version = resolved,
		lockfile = address,
		[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec),
	}
end

--- Forget each declared version and the default. Tests call this, because
--- the module declares a default when it loads.
local function reset_for_test()
	GCC.clear_default()
	install_directories = {}
end

-- Declare the pinned default for the host platform. The JavaScript module
-- fails to load on a platform without a gcc build. This module declares no
-- default there, so that the import does not fail. A workspace can declare
-- its own default with `gcc_toolchain(...)`.
if is_supported_platform(core.platform_info()) then
	gcc_toolchain({ linux = "2025.08-1", windows = "16.2.0posix-14.0.0-ucrt-r1" }, { default = true })
end

return {
	GCC = GCC,
	GCC_GRAPH_TOOL_NAMES = GCC_GRAPH_TOOL_NAMES,
	artifact_name = artifact_name,
	cache_key = cache_key,
	cmake_compiler_args = cmake_compiler_args,
	default_graph_toolchain = default_graph_toolchain,
	default_version = GCC.default_version,
	download_url = download_url,
	gcc_toolchain = gcc_toolchain,
	graph_tool = graph_tool,
	graph_toolchain = graph_toolchain,
	graph_toolchain_dir = graph_toolchain_dir,
	is_gcc_toolchain = is_gcc_toolchain,
	reset_for_test = reset_for_test,
	resolve_version = GCC.resolve_version,
	rust_link_driver_env = rust_link_driver_env,
	supported_platforms = supported_platforms,
	toolchain_record = toolchain_record,
	windows_runtime_archives = windows_runtime_archives,
	winlibs_gcc_version = winlibs_gcc_version,
}
