-- Canonical public entrypoint for shared archive-extraction helpers.
-- Toolchains download with `download_tool_artifact` (@imp/rules/imp/lockfile)
-- and use this module to unpack the artifact, usually into a directory output
-- with a named cache. This is a plain helper and not a base pipeline: each
-- toolchain owns its acquire flow and adds its own steps around it.
local core = require("@imp/core")
local output = core.output

-- tar flags for each tar format. The rule declares gzip and xz explicitly,
-- because tar cannot always detect the compression of a file argument.
-- Zip archives use unzip, not tar. Windows hosts can have two tools named
-- "tar" (the MSYS/GNU tar of Git for Windows, which cannot read zip, and the
-- bsdtar of the OS). The PATH order decides which one runs, and a hermetic
-- build must not depend on that order. unzip has no such alternative.
local FORMAT_FLAGS = {
	["tar.gz"] = "-xzf",
	["tar.xz"] = "-xJf",
	tar = "-xf",
}
local ZIP_FORMATS = { zip = true, ["zip-unix"] = true }
local DECOMPRESSORS = { ["tar.gz"] = "gzip", ["tar.xz"] = "xz" }

--- Return the native-tool names that the extraction script needs for a
--- format. The hermetic sandbox finds only declared tools.
---
--- `format` is one of "tar.gz", "tar.xz", "tar", "zip", or "zip-unix". "zip"
--- and "zip-unix" are equivalent: both use unzip.
local function extract_archive_tools(format)
	if ZIP_FORMATS[format] then
		-- Only a strip_components extraction uses "mv". The tool set comes
		-- from the format alone, not from the call options.
		return { "mkdir", "unzip", "mv" }
	end
	if FORMAT_FLAGS[format] == nil then
		error(`unsupported archive format '{format}'`, 2)
	end
	local tools = { "mkdir", "tar" }
	if DECOMPRESSORS[format] ~= nil then
		table.insert(tools, DECOMPRESSORS[format])
	end
	return tools
end

local function extraction_command(format, strip_components)
	if ZIP_FORMATS[format] then
		-- unzip has no --strip-components option. To remove the top-level
		-- directory of the archive (for example "node-v22.0.0-win-x64/"),
		-- unpack into a staging directory and move the contents of that
		-- directory up.
		if strip_components ~= nil then
			return 'mkdir -p "$2" "$2.stage" && unzip -q "$1" -d "$2.stage" && mv "$2.stage"/*/* "$2"'
		end
		return 'mkdir -p "$2" && unzip -q "$1" -d "$2"'
	end
	local strip = if strip_components ~= nil then ` --strip-components={strip_components}` else ""
	return `mkdir -p "$2" && tar {FORMAT_FLAGS[format]} "$1" -C "$2"{strip}`
end

--- Extract an archive into a directory, and return a directory artifact
--- handle immediately.
---
--- The rule declares its own native tools from `format`, so it rejects a
--- `tools` option. `named_cache` publishes `dest` at a stable absolute path
--- in the tool cache. A toolchain install needs this, because callers
--- outside a sandbox use that path.
---
--- Options:
---   archive           Graph handle of the archive, for example the result
---                     of `download_tool_artifact`.
---   dest              Sandbox-relative extraction directory.
---   format            "tar.gz", "tar.xz", "tar", "zip", or "zip-unix".
---   strip_components  Optional tar --strip-components value. Zip formats
---                     accept only 1.
---   named_cache       Optional `{ name, key }`. Publish `dest` as a named
---                     cache directory output.
---   display           Optional task display label.
local function extract_archive(options)
	if options.tools ~= nil then
		error("extract_archive owns its tools", 2)
	end
	local dest = options.dest
	if type(dest) ~= "string" or #dest == 0 then
		error("extract_archive(options) requires a non-empty dest", 2)
	end
	local format = options.format
	local ok, message = pcall(extract_archive_tools, format)
	if not ok then
		error(message, 2)
	end
	local strip_components = options.strip_components
	-- A value of 0 strips no directory, as no value does.
	if strip_components == 0 then
		strip_components = nil
	end
	if ZIP_FORMATS[format] and strip_components ~= nil and strip_components ~= 1 then
		error("zip extraction only supports strip_components of 1", 2)
	end
	local named_cache = options.named_cache
	local display = options.display or "extract archive"
	local command = extraction_command(format, strip_components)

	local inputs = { archive = options.archive, sh = core.native_tool("sh") }
	for _, name in ipairs(message) do
		inputs[name] = core.native_tool(name)
	end
	return core.task({
		inputs = inputs,
		outputs = { directory = output.artifact() },
		run = function(exec, resolved)
			local directory = if named_cache ~= nil
				then output.directory(dest, { named_cache = named_cache })
				else output.directory(dest)
			local result = exec.action({
				argv = { "sh", "-c", command, "extract-archive", exec.path(resolved.archive), dest },
				inputs = { resolved.archive },
				outputs = { directory = directory },
				display = display,
			})
			return { directory = result.outputs.directory }
		end,
	}).outputs.directory
end

return {
	extract_archive_tools = extract_archive_tools,
	extract_archive = extract_archive,
}
