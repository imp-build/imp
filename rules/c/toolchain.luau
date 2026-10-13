-- The shared C and C++ toolchain contract, and a union that selects one
-- provider for each platform.
--
-- `@imp/rules/c/gcc`, `@imp/rules/c/zig`, and `@imp/rules/c/msvc` each return
-- a provider table with the same fields:
--
--   kind                      "gcc", "zig", or "msvc-host-toolchain".
--   task_inputs()             The graph handles that a compile, archive, link,
--                             or configure task declares as inputs.
--   commands(exec, inputs, opts)
--                             `{ env, rsp_quote, compile_command,
--                             archive_command, link_command }` for a task body.
--   cmake_configure(exec, inputs, opts)
--                             `{ compiler_args, env }` for a CMake configure.
--   resolves_tool_name(name)  True when a replayed CMake edge that runs `name`
--                             uses this toolchain.
--   resolve_state(exec, inputs)
--                             The provider state of a CMake replay edge, or
--                             nil.
--   edge_env(state)           The environment of a replayed CMake edge.
--
-- `env` values are tables of environment names to values, as `exec.action`
-- takes them. The JavaScript providers also have `toolSpec(name)`, a mount
-- for each tool name of a replayed edge. A Luau tool handle puts its whole
-- `bin` directory on PATH, and the MSVC provider puts the host directories on
-- PATH through `env`. Thus the Luau providers do not have `tool_spec`.
--
-- This module adds the part that the contract does not cover: the selection
-- of the active provider for a platform.
local core = require("@imp/core")

local UNION_KIND = "cc-toolchain-union"

--- Quote `value` as one token of an `sh -c` script.
---
--- Each provider runs its compile, archive, and link commands through
--- `sh -c`, also when the native compiler is `cl.exe`. Thus this quoting is
--- the same for each toolchain. Only the content of a response file needs a
--- quoting function for each toolchain, because the native tool parses it.
--- See `rsp_quote` of each provider.
local function shell_quote(value)
	return "'" .. string.gsub(tostring(value), "'", "'\\''") .. "'"
end

--- The optimization flags of `opt` for the gcc and clang flag vocabulary.
--- gcc and zig share them. MSVC uses `/O2 /DNDEBUG` and `/Od /Zi`.
local function clang_opt_flags(opt)
	if opt == "release" then
		return { "-O2", "-DNDEBUG" }
	end
	return { "-O0", "-g" }
end

local function basename(path)
	return string.match(tostring(path), "([^/]*)$")
end

--- The `-Wl,-soname` argument of the link step of a shared library, or no
--- argument for a static library or on Windows. gcc and zig share it.
---
--- Without it, ld copies the link-line path of the library into the
--- DT_NEEDED entry of a consumer, for example `build/c/<name>.so`. The loader
--- reads a DT_NEEDED value with a slash as a path relative to the working
--- directory, and does not use its search paths. The bare filename keeps
--- DT_NEEDED a name that a search path or an rpath can resolve.
local function soname_args(out_path, is_shared)
	if not is_shared or core.platform_info().os == "windows" then
		return {}
	end
	return { shell_quote(`-Wl,-soname,{basename(out_path)}`) }
end

--- The `-Wl,-rpath,$ORIGIN` argument of the link step of a bundled binary,
--- or no argument. gcc and zig share it.
---
--- The loader expands `$ORIGIN` to the directory of the executable, where the
--- binary rule copies the transitive shared libraries. The quotes are
--- necessary: the link tokens go into an `sh -c` script, which would expand
--- `$ORIGIN` to an empty string. Windows finds a DLL beside the executable
--- without an rpath.
local function rpath_origin_args(bundled)
	if not bundled or core.platform_info().os == "windows" then
		return {}
	end
	return { shell_quote("-Wl,-rpath,$ORIGIN") }
end

--- The import library that the link step of a Windows shared library writes
--- beside the DLL, or nil. MSVC `link.exe` cannot link against a DLL. It
--- needs the import library, `<stem>.lib`, the name that `cl.exe /LD` gives
--- it.
local function import_lib_path(out_path, is_shared)
	if not is_shared or core.platform_info().os ~= "windows" then
		return nil
	end
	return (string.gsub(tostring(out_path), "%.dll$", ".lib"))
end

--- The `-Wl,--out-implib` argument that makes a MinGW-style link step write
--- the `import_lib_path` file, or no argument. gcc and zig share it. MSVC
--- writes the same file without a flag.
local function import_lib_args(out_path, is_shared)
	local path = import_lib_path(out_path, is_shared)
	if path == nil then
		return {}
	end
	return { shell_quote(`-Wl,--out-implib,{path}`) }
end

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

--- Wrap one provider for each OS into one union. Give the union to a rule
--- `toolchain` option in place of a provider. The same target then uses gcc
--- on Linux and MSVC on Windows, for example.
---
--- Each `by_os` value is a provider or a function without arguments that
--- returns a provider. A function declares the provider only when the union
--- selects it.
---
--- `select(target_platform?)` selects by `target_platform.os` only. The
--- default is the host platform. The parameter keeps the target platform
--- apart from the execution platform for a later cross-compilation feature.
--- Each provider now resolves for the host only.
local function cc_toolchain_for_platform(by_os)
	local branches = table.clone(by_os)
	local union = {
		kind = UNION_KIND,
		by_os = table.freeze(table.clone(branches)),
	}
	function union.select(target_platform)
		target_platform = target_platform or core.platform_info()
		local branch = branches[target_platform.os]
		if branch == nil then
			local configured = sorted_keys(branches)
			local names = if #configured > 0 then table.concat(configured, ", ") else "none"
			error(
				`no cc toolchain configured for platform '{target_platform.os}' (configured: {names})`,
				2
			)
		end
		return if type(branch) == "function" then branch() else branch
	end
	return table.freeze(union)
end

--- True when `toolchain` is a `cc_toolchain_for_platform` union.
local function is_cc_toolchain_union(toolchain)
	return type(toolchain) == "table" and toolchain.kind == UNION_KIND
end

--- Resolve `toolchain` to a provider. A union selects with
--- `target_platform`. A provider or nil is returned unchanged.
local function select_cc_toolchain(toolchain, target_platform)
	if is_cc_toolchain_union(toolchain) then
		return toolchain.select(target_platform)
	end
	return toolchain
end

return {
	cc_toolchain_for_platform = cc_toolchain_for_platform,
	clang_opt_flags = clang_opt_flags,
	import_lib_args = import_lib_args,
	import_lib_path = import_lib_path,
	is_cc_toolchain_union = is_cc_toolchain_union,
	rpath_origin_args = rpath_origin_args,
	select_cc_toolchain = select_cc_toolchain,
	shell_quote = shell_quote,
	soname_args = soname_args,
}
