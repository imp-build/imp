-- Canonical public entrypoint for toolchain declarations and installed
-- toolchain paths.
--
-- A toolchain module calls `define(name)` one time to get a kind table. The
-- kind table records the declared versions, each with its options, and the
-- default version. The lockfile and acquisition helpers read these records.
--
-- A toolchain declares its acquisition as an ordinary graph task, and
-- publishes the installed tree with the `named_cache` option of
-- `output.directory()`. `core.tool()` makes a tool handle from that output. A
-- sandboxed action needs only the tool handle in its inputs. `bin()` serves a
-- task that must give an absolute host path to a program, for example a
-- linker path in compiler flags. The task declares the tool handle as an
-- input, and `exec.tool_dir()` returns the named-cache directory.
--
-- The JavaScript `Toolchain` class also registers a `bin()` product for
-- `imp @tool`, and `toolchainToolSpec()` makes a legacy `run({ tools })`
-- entry. Luau has neither: `imp @tool` does not dispatch to a Luau
-- workspace, and a tool handle is the `tools` entry of `exec.action` and
-- `core.run_program`.

--- Return a kind table for the toolchain `name`. `name` is used in error
--- messages. The kind table has these functions:
---
---   declare(version, options)  Record `version` and return its instance
---                              `{ version, lockfile, unverified }`.
---                              `options.default = true` also makes it the
---                              default. `options.lockfile` and
---                              `options.unverified` are copied to the
---                              instance.
---   default()                  The default instance, or nil.
---   default_version()          The version of the default instance, or nil.
---   resolve_version(version)   `version` if it is set, else the default
---                              version, or nil.
---   require_version(version)   As `resolve_version`, but fails when no
---                              version is set and no default is set.
---   instance_for_version(version)
---                              The instance that declared `version`, else
---                              the default instance, or nil.
---   resolve_unverified(version)
---                              The `unverified` option of
---                              `instance_for_version(version)`, else false.
---   clear_default()            Forget the default and every declared
---                              version.
local function define(name)
	if type(name) ~= "string" or name == "" then
		error("toolchain.define(name) requires a non-empty name", 2)
	end
	local default_instance = nil
	local by_version = {}
	local kind = {}

	function kind.declare(version, options)
		if type(version) ~= "string" or version == "" then
			error(`{name} toolchain declaration requires a non-empty version`, 2)
		end
		options = options or {}
		local instance = table.freeze({
			version = version,
			lockfile = options.lockfile,
			unverified = options.unverified == true,
		})
		by_version[version] = instance
		if options.default then
			default_instance = instance
		end
		return instance
	end

	function kind.default()
		return default_instance
	end

	function kind.default_version()
		return if default_instance then default_instance.version else nil
	end

	function kind.resolve_version(version)
		if version ~= nil and version ~= "" then
			return version
		end
		return kind.default_version()
	end

	function kind.require_version(version)
		local resolved = kind.resolve_version(version)
		if resolved == nil then
			error(`no {name} toolchain version specified and no default set`, 2)
		end
		return resolved
	end

	function kind.instance_for_version(version)
		return (version and by_version[version]) or default_instance
	end

	function kind.resolve_unverified(version)
		local instance = kind.instance_for_version(version)
		return if instance then instance.unverified else false
	end

	function kind.clear_default()
		default_instance = nil
		by_version = {}
	end

	return table.freeze(kind)
end

--- The absolute host path of one executable in an installed toolchain.
---
--- Call it in a task body. `tool` is a `core.tool()` handle that the task
--- declares as an input. Options:
---
---   exe      Executable filename, with any platform suffix. Necessary.
---   sub_dir  Directory that holds the executable, relative to the named
---            cache root. The default is ".".
local function bin(exec, tool, options)
	options = options or {}
	local exe = options.exe
	if type(exe) ~= "string" or exe == "" then
		error("toolchain.bin(exec, tool, { exe }) requires an executable name", 2)
	end
	local dir = exec.tool_dir(tool)
	local sub_dir = options.sub_dir or "."
	if sub_dir == "." or sub_dir == "" then
		return `{dir}/{exe}`
	end
	return `{dir}/{sub_dir}/{exe}`
end

return {
	bin = bin,
	define = define,
}
