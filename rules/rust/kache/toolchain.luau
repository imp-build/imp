-- Kache acquisition and persistent daemon integration for Cargo tasks.
local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
local lockfile = require("@imp/rules/imp/lockfile")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local toolchain = require("@imp/rules/imp/toolchain")
local KACHE = toolchain.define("kache")
local DEFAULT_LOCKFILE = "@imp/rules/rust/kache/kache.lock"
local triples = {
	["linux-x86_64"] = "x86_64-unknown-linux-musl",
	["linux-aarch64"] = "aarch64-unknown-linux-musl",
	["macos-x86_64"] = "x86_64-apple-darwin",
	["macos-aarch64"] = "aarch64-apple-darwin",
	["windows-x86_64"] = "x86_64-pc-windows-msvc",
	["windows-aarch64"] = "aarch64-pc-windows-msvc",
}
local schema = { cache_executables = core.field.bool({ default = false }) }
core.define_config_schema("kache", schema)
local function artifact_name(_version, plat)
	local triple =
		assert(triples[`{plat.os}-{plat.arch}`], `unsupported kache toolchain platform: {plat.os}/{plat.arch}`)
	return `kache-{triple}.{if plat.os == "windows" then "zip" else "tar.gz"}`
end
local function download_url(version, plat)
	return `https://github.com/kunobi-ninja/kache/releases/download/v{version}/{artifact_name(version, plat)}`
end
local function cache_key(version, plat)
	return `{version}/{plat.os}-{plat.arch}`
end
local function data_cache_key(plat)
	return `{plat.os}-{plat.arch}`
end
local function supported_platforms()
	local result = {}
	for _, key in ipairs({
		"linux-x86_64",
		"linux-aarch64",
		"macos-x86_64",
		"macos-aarch64",
		"windows-x86_64",
		"windows-aarch64",
	}) do
		local os, arch = string.match(key, "^([^-]+)%-(.+)$")
		table.insert(result, { os = os, arch = arch })
	end
	return result
end
local SPEC = lockfiles.register_toolchain_lockfile({
	name = "kache",
	platforms = supported_platforms(),
	download_url = download_url,
	artifact_name = artifact_name,
	lockfile = DEFAULT_LOCKFILE,
}, {
	"0.11.0",
	"0.12.0",
	"0.13.0",
	"0.14.2",
	"0.15.1",
	"0.16.0",
	"0.17.0",
	"0.18.0",
	"0.19.0",
	"0.20.0",
	"0.21.0",
	"0.22.0",
})
local graphs = {}
local declarations = {}
local seeds = {}
local function data_tool(plat)
	local key = data_cache_key(plat)
	if seeds[key] then
		return seeds[key]
	end
	local seed = core.task({
		display = `init kache data dir ({plat.os}/{plat.arch})`,
		inputs = { shell = core.native_tool("sh"), mkdir = core.native_tool("mkdir") },
		outputs = { directory = core.output.artifact() },
		run = function(exec, _input)
			local result = exec.action({
				argv = { "sh", "-c", 'mkdir -p "$1"', "init-kache-data", "kache-data" },
				outputs = {
					directory = core.output.directory(
						"kache-data",
						{ named_cache = { name = "kache-data", key = key, shared = false } }
					),
				},
			})
			return { directory = result.outputs.directory }
		end,
	})
	seeds[key] = core.tool(seed.outputs.directory, { name = "kache-data", bin_dirs = { "." } })
	return seeds[key]
end
local function make_graph(version)
	local plat = core.platform_info()
	local key = cache_key(version, plat)
	local downloaded = lockfile.download_tool_artifact({
		lockfile = lockfile.lockfile_for(KACHE, version, DEFAULT_LOCKFILE),
		tool = "kache",
		version = version,
		plat = plat,
		url = download_url(version, plat),
		output = `kache-downloads/{key}/{artifact_name(version, plat)}`,
		display = `download kache {version} ({plat.os}/{plat.arch})`,
		unverified = KACHE.resolve_unverified(version),
	})
	local directory = archive.extract_archive({
		archive = downloaded,
		dest = "kache-toolchain",
		format = if plat.os == "windows" then "zip" else "tar.gz",
		named_cache = { name = "kache-toolchains", key = key },
		display = `install kache {version} ({plat.os}/{plat.arch})`,
	})
	return {
		tool = core.tool(directory, { name = "kache", bin_dirs = { "." } }),
		data_tool = data_tool(plat),
		version = version,
		executable = if plat.os == "windows" then "kache.exe" else "kache",
	}
end
-- Both handles must be declared inputs of the calling task.
local function build_cache_env(exec, tool, data, options)
	options = options or {}
	local config = core.configuration("kache", {})
	local env = {
		KACHE_CACHE_DIR = exec.tool_dir(data),
		KACHE_MAX_SIZE = options.cache_size or "4GiB",
		KACHE_CACHE_EXECUTABLES = if config.cache_executables then "1" else "0",
		KACHE_LOCAL_ONLY = "1",
		RUSTC_WRAPPER = "kache",
		CARGO_INCREMENTAL = "0",
	}
	local executable = if core.platform_info().os == "windows" then "kache.exe" else "kache"
	local bin = `{exec.tool_dir(tool)}/{executable}`
	exec.worker_start(
		"kache",
		{ argv = { bin, "daemon", "run" }, env = env, health_check_argv = { bin, "daemon", "status" } }
	)
	return env
end
local function kache_toolchain(version, options)
	options = options or {}
	local address = options.lockfile or DEFAULT_LOCKFILE
	lockfile.lockfile_address_to_path(address)
	KACHE.declare(version, { default = options.default, lockfile = address, unverified = options.unverified })
	graphs[version] = make_graph(version)
	local spec = table.clone(SPEC)
	spec.version = version
	spec.lockfile = address
	local declaration = {
		version = version,
		lockfile = address,
		cache_size = options.cache_size or "4GiB",
		[lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile(spec),
	}
	declarations[version] = declaration
	local plat = core.platform_info()
	local graph = graphs[version]
	core.named_cache_details({
		name = "kache-data",
		inputs = { tool = graph.tool, data = graph.data_tool },
		caches = {
			tool = { name = "kache-toolchains", key = cache_key(version, plat) },
			data = { name = "kache-data", key = data_cache_key(plat), shared = false },
		},
		run = function(exec, input)
			local env = build_cache_env(exec, input.tool, input.data, declaration)
			local result = exec.action({
				argv = { `{exec.tool_dir(input.tool)}/{graph.executable}`, "stats" },
				env = env,
				cache = false,
				allow_failure = true,
				display = "kache stats",
			})
			return if result.exit_code == 0 then string.match(result.stdout, "^%s*(.-)%s*$") else nil
		end,
	})
	return declaration
end
local function graph_toolchain(version)
	local resolved = KACHE.require_version(version)
	if not graphs[resolved] then
		graphs[resolved] = make_graph(resolved)
	end
	return graphs[resolved]
end
kache_toolchain("0.22.0", { default = true })
-- Resolve the final workspace default when the CLI requests this tool.
toolchain.register("kache", function()
	return core.task({
		display = "resolve @kache",
		inputs = { tool = graph_toolchain().tool },
		outputs = { value = core.output.value() },
		run = function(exec, inputs)
			return {
				value = toolchain.bin(
					exec,
					inputs.tool,
					{ exe = if core.platform_info().os == "windows" then "kache.exe" else "kache" }
				),
			}
		end,
	}).outputs.value
end)

return {
	KACHE = KACHE,
	kache_toolchain = kache_toolchain,
	graph_toolchain = graph_toolchain,
	build_cache_env = build_cache_env,
	script_preamble = function()
		return 'export KACHE_BASE_DIR="$imp_sandbox_root"; '
	end,
	artifact_name = artifact_name,
	download_url = download_url,
	cache_key = cache_key,
	data_cache_key = data_cache_key,
	supported_platforms = supported_platforms,
	config_schema = schema,
	default_version = KACHE.default_version,
	resolve_version = KACHE.resolve_version,
	default_toolchain = function()
		return declarations[KACHE.default_version()]
	end,
	reset_for_test = function()
		KACHE.clear_default()
		graphs = {}
		declarations = {}
		seeds = {}
	end,
}
