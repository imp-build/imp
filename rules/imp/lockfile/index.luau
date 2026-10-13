-- Canonical public entrypoint for toolchain-lockfile resolution and
-- verified-download helpers.
--
-- A tool lockfile (written by `imp goal gen-lockfiles`) pins the download URL,
-- artifact name, size, and SHA-256 of a toolchain for each version and
-- platform. Lockfiles are additive: each version that was locked stays in the
-- file, so a downgrade to a locked version resolves without regeneration.
--
-- A lockfile has a module-style address. `@imp/rules/<path>` reads the file
-- that ships with the rule library. `@workspace/<path>` reads a file in the
-- workspace. A workspace does not replace a shipped lockfile by a file at the
-- same path: it gives the toolchain an `@workspace/...` address instead.
--
-- Miss policy: a missing lockfile, a different tool, an unlocked version, or
-- no entry for the platform is an error, unless the toolchain was declared
-- with `unverified = true`. Then the miss is a warning, and the download is
-- not verified.
local core = require("@imp/core")
local output = core.output

local ADDRESS_PREFIXES = {
	{ prefix = "@workspace/", path = "" },
	{ prefix = "@imp/rules/", path = "rules/" },
}

--- Convert a lockfile address to the workspace-relative path where
--- gen-lockfiles writes it. `@workspace/a/b.lock` becomes `a/b.lock`.
--- `@imp/rules/a/b.lock` becomes `rules/a/b.lock`, the source path of the
--- shipped rule library in the Imp repository.
local function lockfile_address_to_path(address)
	for _, mapping in ipairs(ADDRESS_PREFIXES) do
		if string.sub(address, 1, #mapping.prefix) == mapping.prefix then
			local relative = string.sub(address, #mapping.prefix + 1)
			if #relative == 0 then
				error(`lockfile address '{address}' must be a workspace-relative file path`, 2)
			end
			for part in string.gmatch(relative .. "/", "([^/]*)/") do
				if part == "" or part == "." or part == ".." then
					error(`lockfile address '{address}' must be a workspace-relative file path`, 2)
				end
			end
			return mapping.path .. relative
		end
	end
	error(`lockfile address '{address}' must start with @workspace/ or @imp/rules/`, 2)
end

--- The lockfile address of a toolchain version: the `lockfile` of the
--- instance that declared the version (else of the default instance), or
--- `fallback_address`, the address of the lockfile that ships with the rule
--- library. `kind` is a kind table from `@imp/rules/imp/toolchain`. The
--- caller passes it, so this module does not require the toolchain module.
local function lockfile_for(kind, version, fallback_address)
	local instance = kind.instance_for_version(version)
	return (instance and instance.lockfile) or fallback_address
end

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

local function resolve_contents(options)
	local address = options.address
	local tool = options.tool
	local version = options.version
	local plat = options.plat
	local function miss(reason)
		local message = `{reason}; run \`imp goal gen-lockfiles\` to regenerate it, `
			.. "or declare the toolchain with `unverified = true` to skip verification"
		if options.unverified then
			core.log_warn(`{message} (continuing unverified)`)
			return nil
		end
		error(message, 0)
	end

	if options.contents == nil then
		return miss(`no lockfile found at {address} for {tool} {version}`)
	end
	local ok, lock = pcall(core.json_decode, options.contents)
	if not ok then
		return miss(`lockfile {address} is not valid JSON ({lock})`)
	end
	if type(lock) ~= "table" or lock.tool ~= tool then
		local pinned = if type(lock) == "table" then tostring(lock.tool) else "nothing"
		return miss(`lockfile {address} pins {pinned}, not {tool}`)
	end
	local versions = lock.versions or {}
	local per_plat = versions[version]
	if per_plat == nil then
		local locked = table.concat(sorted_keys(versions), ", ")
		if locked == "" then
			locked = "none"
		end
		return miss(`lockfile {address} has no entry for {tool} {version} (locked versions: {locked})`)
	end
	local entry = per_plat[`{plat.os}/{plat.arch}`]
	if entry == nil or not entry.sha256 or entry.sha256 == "" or not entry.url or entry.url == "" then
		return miss(`lockfile {address} has no entry for {tool} {version} on platform {plat.os}/{plat.arch}`)
	end
	return entry
end

--- Resolve the lockfile entry that pins a toolchain artifact for a version
--- and platform.
---
--- Returns `{ url, artifact, size?, sha256 }`. `size` is absent in entries
--- from lockfiles that were written before lockfiles became additive. On a
--- miss, raises an error with a pointer to gen-lockfiles. With
--- `unverified = true`, logs a warning and returns nil instead.
---
--- Options: `address` (for example "@imp/rules/python/ruff-toolchain.lock"),
--- `tool` (the lockfile `tool` stem), `version`, `plat` (`{ os, arch }`), and
--- optional `unverified`.
local function resolve_tool_lockfile(options)
	return resolve_contents({
		contents = core.read_file(options.address),
		address = options.address,
		tool = options.tool,
		version = options.version,
		plat = options.plat,
		unverified = options.unverified == true,
	})
end

--- Name of the SHA-256 tool for a platform: `shasum` on macOS, and
--- `sha256sum` on the other platforms (Linux, and Windows through the Git for
--- Windows shell).
local function sha_tool_name(plat)
	return if plat.os == "macos" then "shasum" else "sha256sum"
end

--- Native-tool names that the download script needs. The sandbox is
--- hermetic, so it declares coreutils too. A bare `sh` resolves only on Unix,
--- so the list declares `sh` on Windows only.
local function locked_download_tools(plat)
	local tools = { "curl", "mkdir", "dirname", "wc", sha_tool_name(plat) }
	if plat.os == "windows" then
		table.insert(tools, "sh")
	end
	return tools
end

--- argv of an action that downloads a toolchain artifact to `download_path`.
--- With a `lock_entry` (from `resolve_tool_lockfile`), the action verifies
--- the SHA-256, and the byte size when the entry has one. A mismatch makes
--- the action fail. Without a `lock_entry`, the action downloads `url` and
--- does not verify it.
---
--- Options: `plat`, `lock_entry` (or nil), `url`, `download_path`, and
--- `display_name` (the argv[0] label of the script, for example
--- "download-ruff").
local function locked_download_argv(options)
	local lock_entry = options.lock_entry
	if lock_entry == nil then
		return {
			"sh",
			"-c",
			'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"',
			options.display_name,
			options.download_path,
			options.url,
		}
	end
	local check = if options.plat.os == "macos" then "shasum -a 256 -c -" else "sha256sum -c -"
	local size_check = if lock_entry.size == nil
		then ""
		else ' && actual="$(wc -c < "$1")" && { [ "$actual" -eq "$4" ] || { echo "size mismatch for $1: expected $4 bytes, got $actual" >&2; exit 1; }; }'
	local script = 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"'
		.. size_check
		.. ` && printf '%s  %s\\n' "$3" "$1" | {check}`
	local argv = {
		"sh",
		"-c",
		script,
		options.display_name,
		options.download_path,
		options.url,
		lock_entry.sha256,
	}
	if lock_entry.size ~= nil then
		table.insert(argv, string.format("%d", lock_entry.size))
	end
	return argv
end

--- Download a toolchain artifact. By default, verify it against its
--- lockfile. Each toolchain install task uses this download step with its
--- own extract or install task.
---
--- The function reads the lockfile when it declares the task. The task
--- resolves the entry (a miss is an error, or a warning when `unverified`),
--- runs the verified download, and adds a gen-lockfiles pointer to a failed
--- transfer or a size or SHA-256 mismatch.
---
--- Options:
---   lockfile    Lockfile address, for example "@imp/rules/c/mold/mold.lock".
---   tool        Lockfile `tool` stem, for example "mold".
---   version     Toolchain version.
---   plat        Host platform `{ os, arch }`. It selects the script tools.
---   lock_plat   Optional platform key for the lockfile lookup when it is
---               not the host platform, for example `{ os = "any", arch =
---               "any" }` for a platform-independent artifact.
---   url         Fallback URL when no lock entry resolves.
---   output      Sandbox-relative destination path.
---   display     Optional task display label.
---   unverified  Optional. Make a lockfile miss a warning, and download
---               without verification.
---
--- Returns the artifact handle of the downloaded file.
local function download_tool_artifact(options)
	local output_path = options.output
	if type(output_path) ~= "string" or #output_path == 0 then
		error("download_tool_artifact(options) requires a non-empty output", 2)
	end
	local tool = options.tool
	local display = options.display or `download {tool}`
	local contents = core.read_file(options.lockfile)
	local inputs = { sh = core.native_tool("sh") }
	for _, name in ipairs(locked_download_tools(options.plat)) do
		inputs[name] = core.native_tool(name)
	end
	return core.task({
		inputs = inputs,
		outputs = { artifact = output.artifact() },
		run = function(exec)
			local lock_entry = resolve_contents({
				contents = contents,
				address = options.lockfile,
				tool = tool,
				version = options.version,
				plat = options.lock_plat or options.plat,
				unverified = options.unverified == true,
			})
			local url = if lock_entry ~= nil then lock_entry.url else options.url
			local argv = locked_download_argv({
				plat = options.plat,
				lock_entry = lock_entry,
				url = url,
				download_path = output_path,
				display_name = `download-{tool}`,
			})
			local ok, result = pcall(exec.action, {
				argv = argv,
				outputs = { artifact = output.file(output_path) },
				display = display,
			})
			if not ok then
				if lock_entry ~= nil then
					error(
						`download of {tool} {options.version} from {url} failed transfer or `
							.. `size/sha256 verification (expected {lock_entry.sha256} from {options.lockfile}); `
							.. "if you intentionally changed versions, run `imp goal gen-lockfiles`: "
							.. tostring(result),
						0
					)
				end
				error(result, 0)
			end
			return { artifact = result.outputs.artifact }
		end,
	}).outputs.artifact
end

return {
	lockfile_address_to_path = lockfile_address_to_path,
	lockfile_for = lockfile_for,
	resolve_tool_lockfile = resolve_tool_lockfile,
	sha_tool_name = sha_tool_name,
	locked_download_tools = locked_download_tools,
	locked_download_argv = locked_download_argv,
	download_tool_artifact = download_tool_artifact,
}
