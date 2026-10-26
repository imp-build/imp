-- Graph-native OCI layouts and explicitly selected registry publication.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local publish = require("@imp/rules/workflows/publish")
local crane = require("@imp/rules/oci/toolchain")
local output = core.output

local COMPOSE = [==[
set -eu
umask 022
out=$1; base=$2; entrypoint=$3; cmd=$4; envList=$5; labels=$6; user=$7; workdir=$8
shift 8
mkdir -p "$out/blobs/sha256"
if [ -n "$base" ]; then
  cp -r "$base/." "$out/"
  manifest_digest=$(jq -e -r ".manifests[0].digest" "$out/index.json")
  manifest_digest=${manifest_digest#sha256:}
  manifest_path="$out/blobs/sha256/$manifest_digest"
  config_digest=$(jq -e -r ".config.digest" "$manifest_path")
  config_digest=${config_digest#sha256:}
  config_json=$(cat "$out/blobs/sha256/$config_digest")
  layers_json=$(jq -c ".layers" "$manifest_path")
else
  echo '{"imageLayoutVersion":"1.0.0"}' > "$out/oci-layout"
  config_json=$(jq -n -c '{architecture:"amd64",os:"linux",config:{},rootfs:{type:"layers",diff_ids:[]},history:[]}')
  layers_json='[]'
fi
for tarball in "$@"; do
  digest=$(sha256sum "$tarball"); digest=${digest%% *}
  size=$(wc -c < "$tarball")
  cp "$tarball" "$out/blobs/sha256/$digest"
  config_json=$(printf "%s" "$config_json" | jq -c --arg d "sha256:$digest" ' .rootfs.diff_ids += [$d] | .history += [{"created":"1970-01-01T00:00:00Z","created_by":"imp oci-build"}] ')
  layers_json=$(printf "%s" "$layers_json" | jq -c --arg d "sha256:$digest" --argjson size "$size" '. + [{mediaType:"application/vnd.oci.image.layer.v1.tar",digest:$d,size:$size}]')
done
config_json=$(printf "%s" "$config_json" | jq -S -c --argjson entrypoint "$entrypoint" --argjson cmd "$cmd" --argjson envList "$envList" --argjson labels "$labels" --arg user "$user" --arg workdir "$workdir" ' (if ($entrypoint | length) > 0 then .config.Entrypoint = $entrypoint else . end) | (if ($cmd | length) > 0 then .config.Cmd = $cmd else . end) | (if ($envList | length) > 0 then .config.Env = $envList else . end) | (if ($labels | length) > 0 then .config.Labels = ((.config.Labels // {}) * $labels) else . end) | (if $user != "" then .config.User = $user else . end) | (if $workdir != "" then .config.WorkingDir = $workdir else . end) ')
config_digest=$(printf "%s" "$config_json" | sha256sum); config_digest=${config_digest%% *}
printf "%s" "$config_json" > "$out/blobs/sha256/$config_digest"
config_size=$(wc -c < "$out/blobs/sha256/$config_digest")
manifest_json=$(jq -n -S -c --arg cd "sha256:$config_digest" --argjson cs "$config_size" --argjson layers "$layers_json" '{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",config:{mediaType:"application/vnd.oci.image.config.v1+json",digest:$cd,size:$cs},layers:$layers}')
manifest_digest=$(printf "%s" "$manifest_json" | sha256sum); manifest_digest=${manifest_digest%% *}
printf "%s" "$manifest_json" > "$out/blobs/sha256/$manifest_digest"
manifest_size=$(wc -c < "$out/blobs/sha256/$manifest_digest")
index_json=$(jq -n -S -c --arg md "sha256:$manifest_digest" --argjson ms "$manifest_size" '{schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:[{mediaType:"application/vnd.oci.image.manifest.v1+json",digest:$md,size:$ms,platform:{architecture:"amd64",os:"linux"}}]}')
printf "%s" "$index_json" > "$out/index.json"
printf "sha256:%s" "$manifest_digest"
]==]

local function trim(value)
	return (string.gsub(value, "^%s*(.-)%s*$", "%1"))
end

local function string_value(value, name)
	if type(value) ~= "string" then
		error(`{name} must be a string`, 3)
	end
	return value
end

local function nonempty(value, name)
	if string_value(value, name) == "" then
		error(`{name} must not be empty`, 3)
	end
	return value
end

local function list(value, name)
	if type(value) ~= "table" then
		error(`{name} must be a list`, 3)
	end
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #value then
			error(`{name} must be a dense list`, 3)
		end
		count += 1
	end
	if count ~= #value then
		error(`{name} must be a dense list`, 3)
	end
	return value
end

-- These encoders accept only the two collection shapes that OCI needs.
local function json_string(value)
	string_value(value, "OCI configuration value")
	local escaped = string.gsub(value, '[%z\1-\31\\"]', function(char)
		if char == '"' then
			return '\\"'
		end
		if char == "\\" then
			return "\\\\"
		end
		return string.format("\\u%04x", string.byte(char))
	end)
	return '"' .. escaped .. '"'
end

local function json_array(value, name)
	local parts = {}
	for _, item in ipairs(list(value, name)) do
		table.insert(parts, json_string(item))
	end
	return "[" .. table.concat(parts, ",") .. "]"
end

local function sorted_keys(value, name)
	if type(value) ~= "table" then
		error(`{name} must be a string map`, 3)
	end
	local keys = {}
	for key, item in pairs(value) do
		string_value(key, name .. " key")
		string_value(item, name .. " value")
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

local function json_map(value, name)
	local parts = {}
	for _, key in ipairs(sorted_keys(value, name)) do
		table.insert(parts, json_string(key) .. ":" .. json_string(value[key]))
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

local function command_json(value, name)
	if value == nil then
		value = {}
	end
	if type(value) == "string" then
		value = { value }
	end
	return json_array(value, name)
end

local function workspace_path(value)
	nonempty(value, "OCI source path")
	if string.sub(value, 1, 1) == "/" or string.find(value, "\\", 1, true) or string.match(value, "^%a:") then
		error(`OCI paths must stay within the workspace: {value}`, 3)
	end
	local parts = {}
	for part in string.gmatch(value, "[^/]+") do
		if part == ".." then
			error(`OCI paths must stay within the workspace: {value}`, 3)
		end
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end

local function destination_path(value)
	nonempty(value, "OCI layer path")
	local parts = {}
	for part in string.gmatch(value, "[^/]+") do
		if part == ".." then
			error("OCI layer path must not contain '..'", 3)
		end
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	return table.concat(parts, "/")
end

local function image_of(value, name)
	if
		type(value) ~= "table"
		or type(value.image) ~= "table"
		or not value.image.layout
		or value.image.digest == nil
	then
		error(`{name} requires an oci_pull()/oci_build() image object`, 3)
	end
	return value.image
end

local function tools(inputs, names)
	for _, name in ipairs(names) do
		inputs[name] = core.native_tool(name)
	end
	return inputs
end

local function package_layout(layout)
	return core.task({
		display = "package OCI archive",
		inputs = tools({ layout = layout }, { "sh", "mkdir", "tar" }),
		outputs = { archive = output.artifact() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = {
					"sh",
					"-c",
					'set -eu; umask 022; mkdir -p "$1"; tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner -C "$2" -cf "$1/image.tar" .',
					"oci-package",
					"package",
					exec.path(inputs.layout),
				},
				inputs = { inputs.layout },
				outputs = { archive = output.directory("package") },
				display = "package OCI archive",
			})
			return { archive = result.outputs.archive }
		end,
	}).outputs.archive
end

local function image_result(layout, digest)
	return table.freeze({
		image = table.freeze({ layout = layout, digest = digest }),
		[build.BUILD] = layout,
		[package.PACKAGE] = package_layout(layout),
	})
end

--- Declare a pull by repo and exactly one of tag or digest.
--- Tags resolve without a cache; the resolved digest selects the layout.
local function oci_pull(options)
	options = options or {}
	local repo = nonempty(options.repo, "oci_pull repo")
	local tag, digest = options.tag, options.digest
	if (tag ~= nil) == (digest ~= nil) then
		error("oci_pull requires exactly one of 'tag' or 'digest'", 2)
	end
	local tool = crane.graph_toolchain().tool
	if tag ~= nil then
		nonempty(tag, "oci_pull tag")
		digest = core.task({
			inputs = { crane = tool, repo = repo, tag = tag },
			outputs = { digest = output.value() },
			run = function(exec, inputs)
				local result = exec.action({
					argv = { crane.crane_bin(exec, inputs.crane), "digest", `{inputs.repo}:{inputs.tag}` },
					cache = false,
					display = `resolve {inputs.repo}:{inputs.tag}`,
				})
				return { digest = trim(result.stdout) }
			end,
		}).outputs.digest
	else
		nonempty(digest, "oci_pull digest")
	end
	local layout = core.task({
		inputs = { crane = tool, repo = repo, digest = digest },
		outputs = { layout = output.artifact() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = {
					crane.crane_bin(exec, inputs.crane),
					"pull",
					"--format=oci",
					`{inputs.repo}@{inputs.digest}`,
					"oci-layout",
				},
				outputs = { layout = output.directory("oci-layout") },
				display = `pull {inputs.repo}`,
			})
			return { layout = result.outputs.layout }
		end,
	}).outputs.layout
	return image_result(layout, digest)
end

local LAYER = [==[
set -eu
umask 022
root=$1; stage=$2; out=$3; dest=$4; mode=$5; uid=$6; gid=$7; shift 7
prefix=""; if [ "$root" != "." ]; then prefix="$root/"; fi
mkdir -p "$stage/$dest"
for f in "$@"; do
  rel="${f#"$prefix"}"; target="$stage/$dest/$rel"
  parent=$(dirname "$target"); mkdir -p "$parent"
  cp -- "$f" "$target"
  if [ -n "$mode" ]; then chmod "$mode" "$target"; fi
done
tar --sort=name --mtime="@0" --owner="$uid" --group="$gid" --numeric-owner -C "$stage" -cf "$out" .
]==]

local function layer_tarball(root, layer, index)
	local destination = destination_path(layer.path)
	if #list(layer.srcs, "OCI layer srcs") == 0 then
		error("OCI layer requires non-empty 'srcs'", 3)
	end
	local sources = core.files({ root = root, include = layer.srcs, exclude = layer.exclude or {} })
	return core.task({
		inputs = tools({ sources = sources }, { "sh", "mkdir", "dirname", "cp", "tar", "chmod" }),
		outputs = { tarball = output.artifact() },
		run = function(exec, inputs)
			local paths = exec.paths(inputs.sources)
			if #paths == 0 then
				error(`oci_build layer {index}: no files matched 'srcs'`, 0)
			end
			table.sort(paths)
			local argv = {
				"sh",
				"-c",
				LAYER,
				"oci-layer-tar",
				root,
				`layer-stage-{index}`,
				`layer-{index}.tar`,
				destination,
				if layer.mode ~= nil then tostring(layer.mode) else "",
				tostring(layer.uid or 0),
				tostring(layer.gid or 0),
			}
			for _, path in ipairs(paths) do
				table.insert(argv, path)
			end
			local result = exec.action({
				argv = argv,
				inputs = { inputs.sources },
				outputs = { tarball = output.file(`layer-{index}.tar`) },
				display = `stage OCI layer {index} ({layer.path})`,
			})
			return { tarball = result.outputs.tarball }
		end,
	}).outputs.tarball
end

--- Build a single linux/amd64 image from a base image or "scratch".
--- Options: path, source_base, layers, entrypoint, cmd, env, labels, user,
--- and workdir. Each layer has srcs, path, and optional exclude/mode/uid/gid.
local function oci_build(options)
	options = options or {}
	local base = if options.base == "scratch" then nil else image_of(options.base, "oci_build base")
	local layers = list(options.layers, "oci_build layers")
	if #layers == 0 then
		error("oci_build requires one or more 'layers'", 2)
	end
	local source_base = workspace_path(options.source_base or core.package_path())
	local path = workspace_path(options.path or ".")
	local root = workspace_path(if source_base == "." then path else `{source_base}/{path}`)
	local env = if options.env == nil then {} else options.env
	local env_list = {}
	for _, key in ipairs(sorted_keys(env, "OCI env")) do
		table.insert(env_list, key .. "=" .. env[key])
	end
	local entrypoint, cmd = command_json(options.entrypoint, "OCI entrypoint"), command_json(options.cmd, "OCI cmd")
	local labels = json_map(if options.labels == nil then {} else options.labels, "OCI labels")
	local user, workdir =
		string_value(if options.user == nil then "" else options.user, "OCI user"),
		string_value(if options.workdir == nil then "" else options.workdir, "OCI workdir")
	local inputs = tools({}, { "sh", "jq", "sha256sum", "cp", "mkdir", "wc", "cat" })
	if base then
		inputs.base = base.layout
	end
	for index, layer in ipairs(layers) do
		if type(layer) ~= "table" then
			error("OCI layer must be a table", 2)
		end
		inputs[`layer{index}`] = layer_tarball(root, layer, index)
	end
	local composed = core.task({
		inputs = inputs,
		outputs = { layout = output.artifact(), digest = output.value() },
		run = function(exec, resolved)
			local artifacts = {}
			local base_path = ""
			if resolved.base then
				base_path = exec.path(resolved.base)
				table.insert(artifacts, resolved.base)
			end
			-- Keep the output separate from the staged base without a module counter.
			local image_path = if resolved.base then base_path .. ".derived" else "oci-image"
			local argv = {
				"sh",
				"-c",
				COMPOSE,
				"oci-compose",
				image_path,
				base_path,
				entrypoint,
				cmd,
				json_array(env_list, "OCI env"),
				labels,
				user,
				workdir,
			}
			for index in ipairs(layers) do
				local artifact = resolved[`layer{index}`]
				table.insert(artifacts, artifact)
				table.insert(argv, exec.path(artifact))
			end
			local result = exec.action({
				argv = argv,
				inputs = artifacts,
				outputs = { layout = output.directory(image_path) },
				display = "compose OCI image",
			})
			return { layout = result.outputs.layout, digest = trim(result.stdout) }
		end,
	})
	return image_result(composed.outputs.layout, composed.outputs.digest)
end

--- Publish an image to repo:tag. Only the PUBLISH workflow selects it.
local function oci_push(options)
	options = options or {}
	local image = image_of(options.image, "oci_push image")
	local repo, tag = nonempty(options.repo, "oci_push repo"), nonempty(options.tag, "oci_push tag")
	return table.freeze({
		[publish.PUBLISH] = core.task({
			inputs = { layout = image.layout, crane = crane.graph_toolchain().tool },
			run = function(exec, inputs)
				exec.action({
					argv = { crane.crane_bin(exec, inputs.crane), "push", exec.path(inputs.layout), `{repo}:{tag}` },
					inputs = { inputs.layout },
					cache = false,
					display = `push {repo}:{tag}`,
				})
			end,
		}),
	})
end

--- Copy a registry image from { repo, tag|digest } to { repo, tag }.
--- The copy is uncached and exposes only a PUBLISH root.
local function oci_mirror(options)
	options = options or {}
	local from, to = options.from, options.to
	if type(from) ~= "table" or not from.repo or not (from.tag or from.digest) then
		error("oci_mirror requires 'from: { repo, tag|digest }'", 2)
	end
	if type(to) ~= "table" or not to.repo or not to.tag then
		error("oci_mirror requires 'to: { repo, tag }'", 2)
	end
	local source = nonempty(from.repo, "oci_mirror from.repo")
		.. (
			if from.digest
				then "@" .. nonempty(from.digest, "oci_mirror digest")
				else ":" .. nonempty(from.tag, "oci_mirror tag")
		)
	local destination = nonempty(to.repo, "oci_mirror to.repo") .. ":" .. nonempty(to.tag, "oci_mirror to.tag")
	return table.freeze({
		[publish.PUBLISH] = core.task({
			inputs = { crane = crane.graph_toolchain().tool },
			run = function(exec, inputs)
				exec.action({
					argv = { crane.crane_bin(exec, inputs.crane), "copy", source, destination },
					cache = false,
					display = `mirror {source} -> {destination}`,
				})
			end,
		}),
	})
end

return {

	--- @category target
	oci_pull = oci_pull,
	--- @category target
	oci_build = oci_build,
	--- @category target
	oci_push = oci_push,
	--- @category target
	oci_mirror = oci_mirror,

	--- @category configuration
	crane_toolchain = crane.crane_toolchain,
	default_version = crane.default_version,
	resolve_version = crane.resolve_version,
}
