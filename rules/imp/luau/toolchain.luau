-- Pinned quality tools for Imp authoring modules.
local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")

local function quality_tool(name, version, repository, platforms, artifact)
	local kind = toolchain.define(name)
	local address = `@imp/rules/imp/luau/{name}.lock`
	local function artifact_name(selected, plat)
		assert(
			table.find(platforms, `{plat.os}/{plat.arch}`),
			`unsupported {name} toolchain platform: {plat.os}/{plat.arch}`
		)
		return artifact(plat)
	end
	local function download_url(selected, plat)
		local tag = if name == "stylua" then `v{selected}` else selected
		return `https://github.com/{repository}/releases/download/{tag}/{artifact_name(selected, plat)}`
	end
	local supported = {}
	for _, platform in ipairs(platforms) do
		local os, arch = string.match(platform, "^([^/]+)/(.+)$")
		table.insert(supported, { os = os, arch = arch })
	end
	local spec = lockfiles.register_toolchain_lockfile({
		name = name,
		platforms = supported,
		artifact_name = artifact_name,
		download_url = download_url,
		lockfile = address,
	}, { version })
	local graphs = {}
	local function graph(selected)
		selected = kind.require_version(selected)
		if graphs[selected] then
			return graphs[selected]
		end
		local plat = core.platform_info()
		local key = `{selected}/{plat.os}-{plat.arch}`
		local lock = lockfile.lockfile_for(kind, selected, address)
		local downloaded = lockfile.download_tool_artifact({
			lockfile = lock,
			tool = name,
			version = selected,
			plat = plat,
			url = download_url(selected, plat),
			output = `{name}-downloads/{key}/{artifact_name(selected, plat)}`,
			unverified = kind.resolve_unverified(selected),
			display = `download {name} {selected}`,
		})
		local extracted = archive.extract_archive({
			archive = downloaded,
			dest = `{name}-extracted`,
			format = "zip",
		})
		-- Named caches are immutable. Different archives of the same version
		-- must not select the same install, including unverified downloads.
		local installed = core.task({
			inputs = {
				archive = downloaded,
				extracted = extracted,
				sh = core.native_tool("sh"),
				cp = core.native_tool("cp"),
				mkdir = core.native_tool("mkdir"),
			},
			outputs = { directory = core.output.artifact() },
			run = function(exec, input)
				local digest = string.gsub(exec.digest(input.archive), ":", "-")
				local result = exec.action({
					argv = {
						"sh",
						"-c",
						'mkdir -p "$2" && cp -R "$1"/. "$2"',
						"install-quality-tool",
						exec.path(input.extracted),
						`{name}-toolchain`,
					},
					inputs = { input.extracted },
					outputs = {
						directory = core.output.directory(`{name}-toolchain`, {
							named_cache = { name = `{name}-toolchains`, key = `{key}/{digest}` },
						}),
					},
				})
				return { directory = result.outputs.directory }
			end,
		}).outputs.directory
		graphs[selected] =
			table.freeze({ tool = core.tool(installed, { name = name, bin_dirs = { "." } }), version = selected })
		return graphs[selected]
	end
	local function declare(selected, options)
		options = options or {}
		local lock = options.lockfile or address
		lockfile.lockfile_address_to_path(lock)
		kind.declare(selected, { default = options.default, lockfile = lock, unverified = options.unverified })
		graphs[selected] = nil
		local chosen = table.clone(spec)
		chosen.version, chosen.lockfile = selected, lock
		return {
			version = selected,
			lockfile = lock,
			[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(chosen),
		}
	end
	return {
		declare = declare,
		graph = graph,
		artifact_name = artifact_name,
		download_url = download_url,
		supported_platforms = supported,
	}
end

local stylua = quality_tool("stylua", "2.6.0", "JohnnyMorganz/StyLua", {
	"linux/x86_64",
	"linux/aarch64",
	"macos/x86_64",
	"macos/aarch64",
	"windows/x86_64",
}, function(plat)
	return `stylua-{plat.os}-{plat.arch}.zip`
end)
local analyzer = quality_tool("luau-analyze", "0.709", "luau-lang/luau", {
	"linux/x86_64",
	"macos/aarch64",
	"windows/x86_64",
}, function(plat)
	return `luau-{if plat.os == "linux" then "ubuntu" else plat.os}.zip`
end)
return { stylua = stylua, analyzer = analyzer }
