-- CAS tasks for Biome format and lint facets.
local core = require("@imp/core")
local biome = require("@imp/rules/js/biome/toolchain")
local function biome_root(source, kind)
	local formatting = kind == "fmt"
	return core.task({
		display = `biome {kind} {source.root}`,
		inputs = { sources = source.sources,
			config = core.files({ root = source.root, include = { "biome.json", "biome.jsonc" } }),
			biome = biome.graph_toolchain().tool,
			sh = core.native_tool("sh"), cp = core.native_tool("cp"),
			mkdir = core.native_tool("mkdir"), dirname = core.native_tool("dirname") },
		outputs = { result = core.output.value() },
		run = function(exec, input)
			local paths = exec.paths(input.sources)
			local flags = core.goal_flags()
			local requested = (if formatting then flags.check else flags.fix) == true
			if #paths == 0 then
				return { result = if formatting then { paths = paths, check = { requested = requested, failed = false } }
					else { ok = true, output = "", paths = paths, fix_applied = false } }
			end
			local before = if formatting then exec.digest(input.sources) else nil
			local script = if formatting then
				'root=$1; mode=$2; shift 2; cd "$root" || exit; if [ "$mode" = write ]; then biome format --write "$@"; else biome format "$@"; fi'
				else 'root=$1; fix=$2; shift 2; mkdir -p "fixed/$root" || exit; for config in biome.json biome.jsonc; do if [ -f "$root/$config" ]; then cp "$root/$config" "fixed/$root/$config" || exit; fi; done; for path in "$@"; do mkdir -p "fixed/$root/$(dirname "$path")" && cp "$root/$path" "fixed/$root/$path" || exit; done && cd "fixed/$root" && biome lint --colors=off "$@" ${fix:+--write}'
			local argv = { "sh", "-c", script, `biome-{kind}`, source.root,
				if formatting then (if requested then "check" else "write") else (if requested then "1" else "") }
			for _, path in ipairs(paths) do
				table.insert(argv, if source.root == "." then path else string.sub(path, #source.root + 2))
			end
			local result = exec.action({
				argv = argv, inputs = { input.sources, input.config }, allow_failure = true,
				outputs = { [if formatting then "formatted" else "fixed"] = core.output.directory(if formatting then source.root else "fixed") },
			})
			-- Value outputs carry digest/path tables rather than artifact userdata.
			local text = result.stdout .. "\n" .. result.stderr
			if formatting then return { result = { formatted = { digest = exec.digest(result.outputs.formatted), path = source.root }, sources_digest = before,
				paths = paths, check = { requested = requested, failed = result.exit_code ~= 0 }, output = text } } end
			return { result = { ok = result.exit_code == 0, output = text, paths = paths,
				fixed = if requested then { digest = exec.digest(result.outputs.fixed), path = "fixed" } else nil, fix_applied = requested } }
		end,
	})
end
return {
	biome_fmt_root = function(source) return biome_root(source, "fmt").outputs.result end,
	biome_lint_root = function(source) return biome_root(source, "lint").outputs.result end,
}
