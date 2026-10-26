-- Generate Cargo package declarations for unowned manifests. Import this
-- module explicitly to register the renderer, generator, and Rust settings.
local core = require("@imp/core")
local rust = require("@imp/rules/rust")
local toolchain = require("@imp/rules/rust/toolchain")
local output = core.output
local schema = table.freeze({
	build_generate = core.field.bool({ default = false }),
	doctest = core.field.bool({ default = true }),
})
core.define_config_schema("rust", schema)
core.register_build_rule({ rule = "cargo_package", module = "@imp/rules/rust" })
local EXCLUDES =
	{ "**/.*/**", "**/build/**", "**/coverage/**", "**/dist/**", "**/obj/**", "**/target/**", "**/vendor/**" }
local KEYWORDS = {}
for _, word in ipairs({
	"and",
	"break",
	"continue",
	"do",
	"else",
	"elseif",
	"end",
	"export",
	"false",
	"for",
	"function",
	"if",
	"in",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"return",
	"then",
	"true",
	"type",
	"until",
	"while",
}) do
	KEYWORDS[word] = true
end
local function normalize(path)
	return (string.gsub(path, "\\", "/")):gsub("/+%./", "/"):gsub("^%./", ""):gsub("/+$", "")
end
local function dirname(path)
	return string.match(normalize(path), "^(.*)/[^/]+$") or "."
end
local function identifier(name)
	name = string.gsub(name, "[^%w_]", "_")
	if name == "" then
		name = "root"
	end
	if string.match(name, "^%d") or KEYWORDS[name] then
		name = "_" .. name
	end
	return name
end
local function package_for_manifest(metadata, path)
	path = normalize(path)
	local root = normalize(metadata.workspace_root or "")
	for _, pkg in ipairs(metadata.packages or {}) do
		local manifest = normalize(pkg.manifest_path)
		if
			(path == "Cargo.toml" and manifest == root .. "/Cargo.toml")
			or (path ~= "Cargo.toml" and string.sub(manifest, -#path - 1) == "/" .. path)
		then
			return pkg
		end
	end
	return nil
end
local function declarations(metadata, manifest)
	local pkg = package_for_manifest(metadata, manifest)
	if not pkg then
		return nil
	end
	local bins = {}
	for _, target in ipairs(pkg.targets or {}) do
		if table.find(target.kind or {}, "bin") then
			table.insert(bins, target.name)
		end
	end
	local props = {}
	if #bins > 0 then
		props.bin = if #bins == 1 then bins[1] else bins
	end
	if dirname(pkg.manifest_path) ~= normalize(metadata.workspace_root) then
		props.workspace_member = true
	end
	return { name = identifier(pkg.name), rule = "cargo_package", props = props }
end
local function generate_build()
	local owned, manifests, inputs = {}, {}, {}
	for _, spec in ipairs(rust.cargo_package_specs()) do
		owned[spec.path] = true
	end
	local graph = toolchain.graph_toolchain()
	for _, manifest in ipairs(core.all_unowned({ root = ".", include = { "**/Cargo.toml" }, exclude = EXCLUDES })) do
		if not owned[dirname(manifest)] then
			table.insert(manifests, manifest)
			local metadata = core.task({
				display = `cargo metadata (generate-build) {manifest}`,
				inputs = {
					rustup = graph.tool,
					cargo = graph.cargo_home_tool,
					sources = core.files({
						root = ".",
						include = { "**/Cargo.toml", "Cargo.lock", "**/Cargo.lock", "**/*.rs" },
						exclude = EXCLUDES,
					}),
				},
				outputs = { metadata = output.value() },
				run = function(exec, input)
					local env = toolchain.graph_tool_env(
						exec,
						input.rustup,
						input.cargo,
						graph.toolchain_id,
						graph.version,
						false
					).env
					local result = exec.action({
						display = `cargo metadata (generate-build) {manifest}`,
						argv = {
							"cargo",
							"metadata",
							"--locked",
							"--no-deps",
							"--format-version=1",
							"--manifest-path",
							manifest,
						},
						env = env,
						inputs = { input.sources },
					})
					return { metadata = core.json_decode(result.stdout) }
				end,
			})
			inputs[`metadata{#manifests}`] = metadata.outputs.metadata
		end
	end
	return core.task({
		display = "generate Rust BUILD declarations",
		inputs = inputs,
		outputs = { declarations = output.value() },
		run = function(_exec, input)
			local result = {}
			for index, manifest in ipairs(manifests) do
				local declaration = declarations(input[`metadata{index}`], manifest)
				if declaration then
					local dir = dirname(manifest)
					result[if dir == "." then "BUILD.luau" else dir .. "/BUILD.luau"] = { declaration }
				end
			end
			return { declarations = result }
		end,
	}).outputs.declarations
end
core.register_build_generator({ namespace = "rust", generate = generate_build })
return {
	generate_build = generate_build,
	config_schema = schema,
	package_for_manifest = package_for_manifest,
	declarations = declarations,
}
