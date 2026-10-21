-- The `gen-lockfiles` goal, and the shared code of the toolchain lockfile
-- roots that it publishes.
--
-- A tool lockfile pins the download URL, artifact filename, size, and SHA-256
-- of a toolchain artifact, for each locked version and each platform that
-- the toolchain publishes. An acquire step on any computer then verifies the
-- downloaded bytes, not only a version string (see `@imp/rules/imp/lockfile`).
--
-- Generation is additive. Regeneration after a version bump adds the new
-- version and keeps each version that was locked before, so a downgrade to a
-- locked version needs no regeneration. Regeneration of a locked version
-- replaces the entries of that version.
--
-- A toolchain module puts a `graph_generate_tool_lockfile(...)` root under
-- the `GEN_LOCKFILES` slot of the toolchain target. `imp goal gen-lockfiles
-- //some:address` selects that root. The root task downloads and hashes the
-- artifacts in sandbox actions and makes the lockfile as an artifact. The
-- goal writes the lockfile into the workspace. Thus the graph tasks stay
-- sandboxed.
--
-- Each toolchain module also calls `register_toolchain_lockfile` with the
-- versions that its shipped lockfile pins. The `gen-builtin-lockfiles` goal
-- regenerates every registered lockfile to exactly those versions.
local core = require("@imp/core")
local lockfile = require("@imp/rules/imp/lockfile")
local output = core.output

-- The field order of a lockfile entry. JSON tables in Luau have no order, so
-- the encoder writes these fields first, in this order, as the JavaScript
-- generator did. Thus a regenerated lockfile has the same bytes.
local ENTRY_FIELDS = { "url", "artifact", "size", "sha256" }

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

local function platform_key(plat)
	return `{plat.os}/{plat.arch}`
end

local function encode_string(value)
	local escaped = string.gsub(value, '[%c"\\]', function(char)
		-- `%c` also matches DEL, which JSON writes without an escape.
		if char == "\127" then
			return char
		elseif char == '"' then
			return '\\"'
		elseif char == "\\" then
			return "\\\\"
		elseif char == "\n" then
			return "\\n"
		elseif char == "\r" then
			return "\\r"
		elseif char == "\t" then
			return "\\t"
		elseif char == "\b" then
			return "\\b"
		elseif char == "\f" then
			return "\\f"
		end
		return string.format("\\u%04x", string.byte(char))
	end)
	return `"{escaped}"`
end

local function encode_scalar(value)
	if type(value) == "string" then
		return encode_string(value)
	elseif type(value) == "number" then
		if value == math.floor(value) then
			return string.format("%d", value)
		end
		return tostring(value)
	elseif type(value) == "boolean" then
		return tostring(value)
	end
	error(`lockfile value of type {type(value)} cannot be encoded`, 0)
end

--- Encode an object with `keys` in that order. `encode_value(key, value,
--- indent)` encodes each value.
local function encode_object(map, keys, indent, encode_value)
	if #keys == 0 then
		return "{}"
	end
	local inner = indent .. "  "
	local lines = {}
	for _, key in ipairs(keys) do
		table.insert(lines, `{inner}{encode_string(key)}: {encode_value(key, map[key], inner)}`)
	end
	return "{\n" .. table.concat(lines, ",\n") .. `\n{indent}}`
end

--- The keys of `map`: first the keys in `order` that `map` has, then the
--- other keys, sorted.
local function ordered_keys(map, order)
	local keys = {}
	local seen = {}
	for _, key in ipairs(order) do
		if map[key] ~= nil and not seen[key] then
			table.insert(keys, key)
			seen[key] = true
		end
	end
	for _, key in ipairs(sorted_keys(map)) do
		if not seen[key] then
			table.insert(keys, key)
		end
	end
	return keys
end

--- Encode a lock `{ tool, versions }` as the JSON text of a lockfile.
--- Versions are sorted. The platforms of each version follow
--- `platform_orders[version]` (a list of `os/arch` keys), and other
--- platforms follow, sorted. The entry fields are `url`, `artifact`, `size`,
--- and `sha256`, and other fields follow, sorted. The text uses two-space
--- indentation and ends with a newline.
local function encode_lock(lock, platform_orders)
	platform_orders = platform_orders or {}
	local function encode_entry(_, entry, indent)
		return encode_object(entry, ordered_keys(entry, ENTRY_FIELDS), indent, function(_, value)
			return encode_scalar(value)
		end)
	end
	local function encode_version(version, platforms, indent)
		return encode_object(platforms, ordered_keys(platforms, platform_orders[version] or {}), indent, encode_entry)
	end
	local text = encode_object(lock, { "tool", "versions" }, "", function(key, value, indent)
		if key == "versions" then
			return encode_object(value, sorted_keys(value), indent, encode_version)
		end
		return encode_scalar(value)
	end)
	return text .. "\n"
end

--- The platform keys of a lockfile text in file order. Returns the keys at
--- the second object level (versions, or the platforms of a legacy lock), and
--- for each of these keys, the keys at the third level (platforms). A Luau
--- table has no key order, so the encoder uses these lists to keep the order
--- of the file.
local function file_key_orders(contents)
	local outer = {}
	local inner = {}
	local current = nil
	for line in string.gmatch(contents, "[^\n]+") do
		local key = string.match(line, '^    "(.-)": {')
		if key ~= nil then
			table.insert(outer, key)
			inner[key] = {}
			current = key
		else
			key = string.match(line, '^      "(.-)": {')
			if key ~= nil and current ~= nil then
				table.insert(inner[current], key)
			end
		end
	end
	return outer, inner
end

--- The versions that `contents` locks for tool `name`, as a map from version
--- to platform map, and the platform order of each version in the file. A
--- missing file, invalid JSON, or a lock for a different tool gives empty
--- maps. A legacy single-version lock (`{ tool, version, artifacts }`) gives
--- its one version, so regeneration upgrades it and keeps its entries.
local function existing_locked_versions(contents, name)
	if contents == nil then
		return {}, {}
	end
	local ok, existing = pcall(core.json_decode, contents)
	if not ok or type(existing) ~= "table" or existing.tool ~= name then
		return {}, {}
	end
	local outer, inner = file_key_orders(contents)
	if type(existing.versions) == "table" then
		return existing.versions, inner
	end
	if type(existing.version) == "string" and type(existing.artifacts) == "table" then
		return { [existing.version] = existing.artifacts }, { [existing.version] = outer }
	end
	return {}, {}
end

--- The task inputs of a lockfile task: the native tools of the download,
--- hash, and write scripts.
local function lock_tool_inputs()
	local inputs = { sh = core.native_tool("sh"), cp = core.native_tool("cp") }
	for _, name in ipairs(lockfile.locked_download_tools(core.platform_info())) do
		inputs[name] = core.native_tool(name)
	end
	return inputs
end

--- Download each artifact of `version` and return its platform map. Each
--- download is an uncached action that prints the SHA-256 and the byte size
--- of the artifact.
local function lock_version_artifacts(exec, options)
	local host = core.platform_info()
	local sha = if host.os == "macos" then "shasum -a 256" else lockfile.sha_tool_name(host)
	local script = `curl -fSL -o "$1" "$2" && {sha} "$1" && wc -c < "$1"`
	local artifacts = {}
	for _, plat in ipairs(options.platforms) do
		local url = options.download_url(options.version, plat)
		local key = platform_key(plat)
		local result = exec.action({
			argv = { "sh", "-c", script, `lock-{options.name}`, "artifact", url },
			cache = false,
			display = `lock {options.name} {options.version} {key}`,
		})
		local stdout = result.stdout
		local digest = string.match(stdout, "^(%x+)")
		local size = string.match(stdout, "\n%s*(%d+)%s*$")
		if digest == nil or #digest ~= 64 or size == nil then
			error(`could not read the SHA-256 and size of {url} from: {stdout}`, 0)
		end
		artifacts[key] = {
			url = url,
			artifact = options.artifact_name(options.version, plat),
			size = tonumber(size),
			sha256 = digest,
		}
	end
	return artifacts
end

--- Write `lock` to `path` in an action, and return the artifact.
local function write_lock(exec, path, lock, platform_orders)
	local source = exec.file({ path = path .. ".imp-content", contents = encode_lock(lock, platform_orders) })
	local result = exec.action({
		argv = {
			"sh",
			"-c",
			'mkdir -p "$(dirname "$1")" && cp "$2" "$1"',
			"lockfile-write",
			path,
			exec.path(source),
		},
		inputs = { source },
		outputs = { lockfile = output.file(path) },
		display = `write {path}`,
	})
	return result.outputs.lockfile
end

--- Make a lockfile task. `merge` gives the existing versions to keep, or
--- nil for none. Its result is `{ lock, path, lockfile }`.
local function lockfile_task(options, versions, merge)
	local address = options.lockfile or `@workspace/{options.name}.lock`
	local path = lockfile.lockfile_address_to_path(address)
	local existing, existing_orders = {}, {}
	if merge then
		existing, existing_orders = existing_locked_versions(core.read_file(address), options.name)
	end
	local declared_order = {}
	for _, plat in ipairs(options.platforms) do
		table.insert(declared_order, platform_key(plat))
	end
	return core.task({
		inputs = lock_tool_inputs(),
		outputs = { lock = output.value(), path = output.value(), lockfile = output.artifact() },
		run = function(exec)
			local locked = table.clone(existing)
			-- An existing version keeps the platform order of the file. A
			-- version that this task locks uses the declared order.
			local orders = table.clone(existing_orders)
			for _, version in ipairs(versions) do
				orders[version] = declared_order
				locked[version] = lock_version_artifacts(exec, {
					version = version,
					name = options.name,
					platforms = options.platforms,
					download_url = options.download_url,
					artifact_name = options.artifact_name,
				})
			end
			local lock = { tool = options.name, versions = locked }
			return {
				lock = lock,
				path = path,
				lockfile = write_lock(exec, path, lock, orders),
			}
		end,
	})
end

--- Declare the lockfile regeneration of one toolchain version as a graph
--- root for the `GEN_LOCKFILES` slot.
---
--- Options:
---   version        Toolchain version to lock.
---   name           Tool name. It is the lockfile `tool` field.
---   platforms      Published platforms, a list of `{ os, arch }`.
---   download_url   `function(version, plat)` that returns the artifact URL.
---   artifact_name  `function(version, plat)` that returns the artifact
---                  filename.
---   lockfile       Optional lockfile address, for example
---                  "@imp/rules/zola/zola.lock". The default is
---                  `@workspace/<name>.lock`.
---
--- The task keeps the other versions that the lockfile has. It resolves to
--- `{ lock, path, lockfile }`: the lock contents, the workspace path, and the
--- written lockfile artifact.
local function graph_generate_tool_lockfile(options)
	return lockfile_task(options, { options.version }, true)
end

--- The workspace write of one `GEN_LOCKFILES` root result, or nil when the
--- result is not a lockfile result.
local function lockfile_write(result)
	if type(result) ~= "table" or type(result.path) ~= "string" then
		return nil
	end
	if type(result.lockfile) ~= "table" or type(result.lockfile.digest) ~= "string" then
		return nil
	end
	if result.kind == "python-project-lock" and type(result.project) == "string" then
		return { path = result.path, digest = result.lockfile.digest, name = `Python {result.project}` }
	end
	if type(result.lock) == "table" and type(result.lock.tool) == "string" and type(result.lock.versions) == "table" then
		return { path = result.path, digest = result.lockfile.digest, name = result.lock.tool }
	end
	return nil
end

--- Check each selected `GEN_LOCKFILES` root, then write its lockfile into
--- the workspace. A root is a `graph_generate_tool_lockfile` result, or a
--- Python project lock `{ kind = "python-project-lock", project, path,
--- lockfile }`.
---
--- Each root merges with the lockfile that it read when the graph was
--- declared. Thus two roots that write the same lockfile cannot both keep
--- their versions, and the goal fails before it writes a file.
local function graph_gen_lockfiles_goal(roots)
	local writes = {}
	local owners = {}
	for _, root in ipairs(roots) do
		local write = lockfile_write(root.result)
		if write == nil then
			core.goal_error(
				`{root.address}: gen-lockfiles graph root must resolve to a graph_generate_tool_lockfile() or Python project lock result`
			)
		end
		local owner = owners[write.path]
		if owner ~= nil then
			core.goal_error(
				`{owner} and {root.address} both write {write.path}; select one of them for each gen-lockfiles run`
			)
		end
		owners[write.path] = root.address
		table.insert(writes, write)
	end
	local names = {}
	for _, write in ipairs(writes) do
		core.write_workspace(write.path, write.digest, { from = write.path })
		table.insert(names, write.name)
	end
	return `gen-lockfiles: regenerated {#names} lockfile(s): {table.concat(names, ", ")}`
end

local builtin_registry = {}

--- Register the shipped lockfile of a toolchain. Each toolchain module calls
--- this function one time when it loads. `spec` has the options of
--- `graph_generate_tool_lockfile` without `version`, and `versions`, the
--- list of versions that the lockfile pins. The `lockfile` address is
--- necessary. Regeneration writes exactly these versions.
local function register_builtin_lockfile(spec)
	if type(spec.lockfile) ~= "string" or spec.lockfile == "" then
		error(`builtin lockfile for '{spec.name}' must declare a lockfile address`, 2)
	end
	if type(spec.versions) ~= "table" or #spec.versions == 0 then
		error(`builtin lockfile for '{spec.name}' must declare at least one version`, 2)
	end
	table.insert(builtin_registry, spec)
end

--- The registered builtin lockfile specs, in registration order.
local function builtin_lockfiles()
	return table.clone(builtin_registry)
end

--- Register the builtin lockfile of a toolchain with `versions`, and return
--- `spec` for the `graph_generate_tool_lockfile` root of the toolchain.
local function register_toolchain_lockfile(spec, versions)
	local registered = table.clone(spec)
	registered.versions = versions
	register_builtin_lockfile(registered)
	return spec
end

--- Declare the regeneration of a builtin lockfile to exactly its registered
--- versions. The task does not keep the existing contents. It resolves to
--- `{ lock, path, lockfile }`, as `graph_generate_tool_lockfile` does.
local function generate_builtin_lockfile(spec)
	return lockfile_task(spec, spec.versions, false)
end

return {
	GEN_LOCKFILES = core.goal("gen-lockfiles", graph_gen_lockfiles_goal),
	builtin_lockfiles = builtin_lockfiles,
	encode_lock = encode_lock,
	generate_builtin_lockfile = generate_builtin_lockfile,
	graph_gen_lockfiles_goal = graph_gen_lockfiles_goal,
	graph_generate_tool_lockfile = graph_generate_tool_lockfile,
	register_builtin_lockfile = register_builtin_lockfile,
	register_toolchain_lockfile = register_toolchain_lockfile,
}
