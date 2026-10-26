-- Import this extension before declaring packages that need formatting.
local core = require("@imp/core")
local odin = require("@imp/rules/odin")
local toolchain = require("@imp/rules/odin/odinfmt/toolchain")
local fmt = require("@imp/rules/workflows/fmt")
local function odin_fmt_root(source)
	local config = core.files({ root = ".", include = { "odinfmt.json" } })
	return core.task({
		display = `odinfmt {source.base}`,
		inputs = {
			sources = source.sources,
			config = config,
			formatter = toolchain.graph_toolchain().tool,
			sh = core.native_tool("sh"),
		},
		outputs = { result = core.output.value() },
		run = function(exec, input)
			local paths = {}
			for _, path in ipairs(exec.paths(input.sources)) do
				if string.match(path, "%.odin$") then
					table.insert(paths, path)
				end
			end
			local check = core.goal_flags().check == true
			if #paths == 0 then
				return { result = { paths = paths, check = { requested = check, failed = false } } }
			end
			local configs = exec.paths(input.config)
			local argv = {
				"sh",
				"-c",
				'formatter=$1; config=$2; shift 2; status=0; for path in "$@"; do if [ -n "$config" ]; then "$formatter" -w "-config=$config" "$path" || status=1; else "$formatter" -w "$path" || status=1; fi; done; exit $status',
				"odinfmt",
				toolchain.bin(exec, input.formatter),
				configs[1] or "",
			}
			for _, path in ipairs(paths) do
				table.insert(argv, path)
			end
			local before = exec.digest(input.sources)
			local result = exec.action({
				argv = argv,
				inputs = { input.sources, input.config },
				allow_failure = true,
				outputs = { formatted = core.output.directory(source.base) },
			})
			return {
				result = {
					formatted = { digest = exec.digest(result.outputs.formatted), path = source.base },
					sources_digest = before,
					paths = paths,
					check = { requested = check, failed = result.exit_code ~= 0 },
					output = result.stdout .. "\n" .. result.stderr,
				},
			}
		end,
	}).outputs.result
end
odin.register_odin_package_hook(function(source)
	return { [fmt.FMT] = odin_fmt_root(source) }
end)
return {
	--- @category configuration
	odinfmt_toolchain = toolchain.odinfmt_toolchain,
	odinfmt_gen_lockfiles = toolchain.odinfmt_gen_lockfiles,
	odin_fmt_root = odin_fmt_root,
	default_odinfmt_toolchain_version = toolchain.default_version,
}
