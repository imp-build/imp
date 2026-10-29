-- The C compiler of the macOS host.
--
-- gcc and zig have no macOS lockfile entry, so a macOS action compiles and
-- links C with the Apple clang of the Xcode Command Line Tools. The rustc
-- and Odin macOS link steps use the host SDK and its clang already, so a
-- managed compiler does not remove this host dependency.
--
-- `default_graph_toolchain()` returns a record with native tool handles for
-- `cc`, `clang`, and `ar`. Each action that declares a handle as a task input
-- finds the tool on its PATH by its bare name. This record is not a provider
-- of the shared C toolchain contract (see `@imp/rules/c/toolchain`):
-- `cc_library` and CMake do not use it.
local core = require("@imp/core")

local KIND = "host-cc"

--- The host C compiler record on macOS, or nil on another platform.
---
--- Returns `{ kind, tool, clang_tool, ar_tool }`. `tool` is `cc`. Odin's
--- darwin link step runs `clang`, and cc-rs build scripts run `ar`.
local function default_graph_toolchain()
	if core.platform_info().os ~= "macos" then
		return nil
	end
	return table.freeze({
		kind = KIND,
		tool = core.native_tool("cc"),
		clang_tool = core.native_tool("clang"),
		ar_tool = core.native_tool("ar"),
	})
end

--- True when `value` is a host C compiler record.
local function is_host_toolchain(value)
	return type(value) == "table" and value.kind == KIND
end

--- The rustflags and environment that make rustc and cc-rs use the host
--- compiler. Declare `tool` and `ar_tool` of the record as task inputs.
---
--- Returns `{ rustflags, env, path_dirs }`, the shape of
--- `gcc.rust_link_driver_env`. The tools are on PATH, so `path_dirs` is
--- empty. With `kache_active`, CC and CXX run the compiler through kache.
local function rust_link_driver_env(kache_active)
	local env = if kache_active then { CC = "kache cc", CXX = "kache c++" } else { CC = "cc" }
	return { rustflags = { "-C", "linker=cc" }, env = env, path_dirs = {} }
end

return {
	default_graph_toolchain = default_graph_toolchain,
	is_host_toolchain = is_host_toolchain,
	rust_link_driver_env = rust_link_driver_env,
}
