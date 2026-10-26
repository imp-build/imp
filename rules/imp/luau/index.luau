-- Quality rules for Imp workspace, BUILD, rule, and test modules.
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local tools = require("@imp/rules/imp/luau/toolchain")

local function quality_root(sources, base, formatting)
	local config =
		core.files({ root = ".", include = if formatting then { ".stylua.toml", "stylua.toml" } else { ".luaurc" } })
	return core.task({
		display = `{if formatting then "stylua" else "luau-analyze"} {base}`,
		inputs = {
			sources = sources,
			config = config,
			tool = (if formatting then tools.stylua else tools.analyzer).graph().tool,
		},
		outputs = { result = core.output.value() },
		run = function(exec, input)
			local paths = exec.paths(input.sources)
			local check = formatting and core.goal_flags().check == true
			if #paths == 0 then
				return {
					result = if formatting
						then { paths = paths, check = { requested = check, failed = false } }
						else { paths = paths, ok = true, fix_applied = false },
				}
			end
			local before = if formatting then exec.digest(input.sources) else nil
			local argv = if formatting
				then { "stylua", "--syntax", "Luau", "--no-editorconfig" }
				else { "luau-analyze", "--formatter=gnu" }
			if formatting and check then
				table.insert(argv, "--check")
			end
			for _, path in ipairs(paths) do
				table.insert(argv, path)
			end
			local result = exec.action({
				argv = argv,
				inputs = { input.sources, input.config },
				allow_failure = true,
				outputs = if formatting then { formatted = core.output.directory(".") } else {},
			})
			local text = result.stdout .. result.stderr
			if not formatting then
				return { result = { paths = paths, ok = result.exit_code == 0, output = text, fix_applied = false } }
			end
			return {
				result = {
					paths = paths,
					sources_digest = before,
					formatted = { digest = exec.digest(result.outputs.formatted), path = "." },
					check = { requested = check, failed = result.exit_code ~= 0 },
					output = text,
				},
			}
		end,
	}).outputs.result
end

--- Declare format and lint roots for Imp authoring sources.
--- @param options Source patterns in srcs, optional base, and exclude patterns.
--- @returns A frozen table with sources, FMT, and LINT roots.
--- @category target
local function luau_sources(options)
	assert(
		type(options) == "table" and type(options.srcs) == "table" and #options.srcs > 0,
		"luau_sources requires non-empty srcs"
	)
	local base = options.base or core.package_path()
	local sources = core.files({ root = base, include = options.srcs, exclude = options.exclude or {} })
	return table.freeze({
		sources = sources,
		[fmt.FMT] = quality_root(sources, base, true),
		[lint.LINT] = quality_root(sources, base, false),
	})
end
--- Declare a StyLua version for Imp authoring sources.
--- @param version Release version without the v prefix.
--- @param options Optional default, lockfile, and unverified settings.
--- @returns The version, lockfile address, and GEN_LOCKFILES root.
--- @category configuration
local function stylua_toolchain(version, options)
	return tools.stylua.declare(version, options)
end

--- Declare a Luau analyzer version for Imp authoring sources.
--- @param version Release version.
--- @param options Optional default, lockfile, and unverified settings.
--- @returns The version, lockfile address, and GEN_LOCKFILES root.
--- @category configuration
local function luau_analyzer_toolchain(version, options)
	return tools.analyzer.declare(version, options)
end

return {
	luau_sources = luau_sources,
	stylua_toolchain = stylua_toolchain,
	luau_analyzer_toolchain = luau_analyzer_toolchain,
}
