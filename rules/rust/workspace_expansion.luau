-- Cargo metadata discovers named children. Each real workspace shares one
-- compile, Clippy, rustfmt, and doctest action. Private dependencies are
-- supplied by ./index, so these modules have no cyclic imports.
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local test = require("@imp/rules/workflows/test")
local cargo_inputs = require("./cargo_task_inputs")
local codegen = require("@imp/rules/imp/codegen")
local output = core.output
local function append(list, values)
	for _, value in ipairs(values or {}) do table.insert(list, value) end
	return list
end
local function merge(target, values)
	for key, value in pairs(values) do target[key] = value end
	return target
end
local function normalize(path) return (string.gsub(path, "\\", "/")) end
local function dirname(path) return string.match(normalize(path), "^(.*)/[^/]+$") or "." end
local function lines_json(text)
	local values = {}
	for line in string.gmatch(text, "[^\n]+") do
		local ok, value = pcall(core.json_decode, line)
		if ok and type(value) == "table" then table.insert(values, value) end
	end
	return values
end
local function parse_test_binaries(text, build_dir)
	local values = {}
	for _, message in ipairs(lines_json(text)) do
		if message.reason == "compiler-artifact" and message.executable and message.profile and message.profile.test then
			local path = normalize(message.executable)
			local start = string.find(path, build_dir .. "/", 1, true)
			assert(start, `Cargo test binary is outside {build_dir}: {path}`)
			table.insert(values, { path = string.sub(path, start + #build_dir + 1), manifest = if message.manifest_path then normalize(message.manifest_path) else nil, name = message.target.name, kind = (message.target.kind or {})[1] or "test" })
		end
	end
	return values
end
local function belongs(path, dir)
	return dir == "." or string.find("/" .. normalize(path), "/" .. dir .. "/", 1, true) ~= nil
end
local function lib_name(pkg)
	for _, target in ipairs(pkg.targets or {}) do
		for _, kind in ipairs(target.kind or {}) do if kind == "lib" or kind == "proc-macro" then return target.name end end
	end
	return nil
end
local function noop(name)
	return core.task({ display = name, outputs = { units = output.value() }, run = function() return { units = {} } end }).outputs.units
end

-- Capture only test executables, rather than Cargo's entire target tree.
-- set -e preserves a compilation failure before the final copy pipeline.
local TEST_BUILD = 'set -e; bins_dir="$target_dir.bins"; report="$target_dir.json"; mkdir -p "$bins_dir"; '
	.. 'cargo test -j "$IMP_CORES" --locked --no-run --message-format=json --manifest-path "$manifest" --target-dir "$target_dir" "$@" > "$report"; cat "$report"; '
	.. 'jq -r \'select(.reason=="compiler-artifact" and .profile.test==true and .executable != null) | .executable\' "$report" | '
	.. 'while IFS= read -r exe; do exe=$(printf %s "$exe" | tr -d "\\r" | tr "\\\\" /); '
	.. 'case "$exe" in *"$target_dir"/*) rel=${exe#*"$target_dir"/} ;; *) exit 1 ;; esac; '
	.. 'case "$rel" in */*) mkdir -p "$bins_dir/${rel%/*}" ;; esac; cp "$exe" "$bins_dir/$rel"; done'

local function new(helpers)
	local workspace_cache = {}
	local function registry(dirs, field)
		local values, seen = {}, {}
		for _, spec in ipairs(helpers.package_specs()) do
			if table.find(dirs, spec.path) then
				for _, value in ipairs(spec[field]) do
					if not seen[value] then seen[value] = true; table.insert(values, value) end
				end
			end
		end
		return values
	end
	local function metadata(root, spec)
		local sources = if spec.builtin then cargo_inputs.builtin_cargo_manifest_sources else cargo_inputs.cargo_manifest_sources
		local inputs = helpers.tool_inputs(spec, false)
		inputs.manifests = sources(root, { recursive = true })
		return core.task({
			display = `cargo metadata {root}`, inputs = inputs, outputs = { metadata = output.value() },
			run = function(exec, input)
				local env = helpers.tool_env(exec, input, spec)
				local result = exec.action({ display = `cargo metadata {root}`, argv = { "cargo", "metadata", "--locked", "--no-deps", "--format-version=1", "--manifest-path", `{root}/Cargo.toml` }, env = env, inputs = { input.manifests } })
				return { metadata = core.json_decode(result.stdout) }
			end,
		})
	end
	local function create_children(root, spec, metadata_value, workspace)
		local sources = if spec.builtin then cargo_inputs.builtin_cargo_manifest_sources else cargo_inputs.cargo_manifest_sources
		local manifests = sources(root, { recursive = true })
		local members, dirs = {}, {}
		for _, pkg in ipairs(metadata_value.packages or {}) do
			local manifest = normalize(pkg.manifest_path)
			local standalone_match = if root == "." then manifest == normalize(metadata_value.workspace_root) .. "/Cargo.toml" else string.sub(manifest, -#root - 12) == "/" .. root .. "/Cargo.toml"
			if (workspace and table.find(metadata_value.workspace_members or {}, pkg.id)) or (not workspace and standalone_match) then
				local dir = if workspace then dirname(string.sub(normalize(pkg.manifest_path), #normalize(metadata_value.workspace_root) + 2)) else root
				table.insert(members, { pkg = pkg, dir = dir })
				table.insert(dirs, dir)
			end
		end
		local generated = codegen.dedupe_generated_srcs(registry(dirs, "generated_srcs"), { rule = "cargo_package" })
		local compile = cargo_inputs.cargo_task_inputs({ deps = registry(dirs, "deps"), generated_srcs = generated })
		local runtime = cargo_inputs.cargo_task_inputs({ deps = registry(dirs, "deps"), test_deps = registry(dirs, "test_deps"), test_tools = registry(dirs, "test_tools"), generated_srcs = generated })
		local base = helpers.tool_inputs(spec, true)
		base.manifests = manifests
		local build_dir = `build/rust/{if root == "." then "root" else string.gsub(root, "/", "_")}`
		local extra = if workspace then { "--workspace" } else {}
		local clippy = core.task({
			display = `cargo clippy {if workspace then "--workspace " else ""}{root}`,
			inputs = merge(table.clone(base), compile.bindings("compile")), outputs = { report = output.value() },
			run = function(exec, input)
				compile.validate_generated_srcs(exec, input)
				local env, flags, active = helpers.tool_env(exec, input, spec)
				env.RUSTFLAGS = flags; env.CARGO_BUILD_JOBS = "$IMP_CORES"
				local argv = append({ "cargo", "clippy", "--locked", "--message-format=json", "--manifest-path", `{root}/Cargo.toml` }, extra)
				if not workspace then append(argv, { "--", "-D", "warnings" }) end
				if active then
					table.remove(argv, 1)
					argv = append({ "sh", "-c", helpers.cargo_script('cargo "$@"', true), "cargo-clippy", `{root}/Cargo.toml`, build_dir, flags }, argv)
				end
				local result = exec.action({ display = `cargo clippy {root}`, argv = argv, env = env, cores = 8, inputs = append({ input.manifests }, compile.resolved(input, "compile")), allow_failure = true })
				return { report = { exit_code = result.exit_code, messages = lines_json(result.stdout), stderr = result.stderr, stdout = result.stdout } }
			end,
		})
		local test_inputs = merge(table.clone(base), compile.bindings("compile"))
		for _, name in ipairs({ "jq", "mkdir", "cp", "cat", "tr" }) do test_inputs[name] = core.native_tool(name) end
		local test_build = core.task({
			display = `cargo test --no-run {if workspace then "--workspace " else ""}{root}`, inputs = test_inputs,
			outputs = { binaries = output.artifact(), report = output.value() },
			run = function(exec, input)
				compile.validate_generated_srcs(exec, input)
				local env, flags, active = helpers.tool_env(exec, input, spec)
				-- The full script needs RUSTFLAGS for cargo's child processes.
				local script = helpers.cargo_script('export RUSTFLAGS; ' .. TEST_BUILD, active)
				local argv = append({ "sh", "-c", script, "cargo-test-build", `{root}/Cargo.toml`, build_dir, flags }, extra)
				local result = exec.action({ display = `cargo test-build {root}`, argv = argv, env = env, cores = 8, inputs = append({ input.manifests }, compile.resolved(input, "compile")), outputs = { binaries = output.directory(build_dir .. ".bins") } })
				return { binaries = result.outputs.binaries, report = { stdout = result.stdout } }
			end,
		})
		local format = core.task({
			display = `cargo fmt {if workspace then "--workspace " else ""}{root}`, inputs = base,
			outputs = { formatted = output.artifact(), report = output.value() },
			run = function(exec, input)
				local env = helpers.tool_env(exec, input, spec)
				local argv = { "cargo", "fmt", "--manifest-path", `{root}/Cargo.toml` }
				if workspace then table.insert(argv, "--all") end
				local check = core.goal_flags().check == true
				if check then table.insert(argv, "--check") end
				local result = exec.action({ display = `cargo fmt {root}`, argv = argv, env = env, inputs = { input.manifests }, outputs = { formatted = output.directory(root) }, allow_failure = true })
				local unformatted = {}
				for line in string.gmatch(result.stdout, "[^\n]+") do
					local path = string.match(line, "^Diff in (.+):%d+:")
					if path then table.insert(unformatted, normalize(path)) end
				end
				return { formatted = result.outputs.formatted, report = { exit_code = result.exit_code, unformatted = unformatted, text = result.stdout .. result.stderr, check = check } }
			end,
		})
		local docs
		if core.configuration("rust", {}).doctest ~= false then
			docs = core.task({
				display = `cargo test --doc {if workspace then "--workspace " else ""}{root}`, inputs = merge(merge(table.clone(base), runtime.bindings("runtime")), runtime.bindings("tools")),
				outputs = { report = output.value() },
				run = function(exec, input)
					runtime.validate_generated_srcs(exec, input)
					local env, flags, active = helpers.tool_env(exec, input, spec)
					env.RUSTFLAGS = flags; env.CARGO_BUILD_JOBS = "$IMP_CORES"
					local argv = append({ "cargo", "test", "--locked", "--doc", "--no-fail-fast", "--manifest-path", `{root}/Cargo.toml`, "--target-dir", build_dir .. "-doc" }, extra)
					if active then
						table.remove(argv, 1)
						argv = append({ "sh", "-c", helpers.cargo_script('cargo "$@"', true), "cargo-doctest", `{root}/Cargo.toml`, build_dir, flags }, argv)
					end
					local result = exec.action({ display = `cargo doctest {root}`, argv = argv, env = env, cores = 8, cache = false, inputs = append({ input.manifests }, runtime.resolved(input, "runtime")), allow_failure = true })
					return { report = { exit_code = result.exit_code, text = result.stdout .. result.stderr } }
				end,
			})
		end
		local children = {}
		for _, member in ipairs(members) do
			local pkg, dir = member.pkg, member.dir
			local lint_result = core.task({
				display = `attribute cargo clippy {dir}`, inputs = { report = clippy.outputs.report }, outputs = { result = output.value() },
				run = function(_exec, input)
					local diagnostics, failed = {}, false
					for _, msg in ipairs(input.report.messages) do
						local path = (msg.target or {}).src_path or msg.manifest_path
						if msg.reason == "compiler-message" and path and belongs(path, dir) and msg.message then
							if msg.message.rendered then table.insert(diagnostics, msg.message.rendered) end
							if msg.message.level == "warning" or msg.message.level == "error" then failed = true end
						end
					end
					if input.report.exit_code ~= 0 and #diagnostics == 0 then return { result = { ok = false, output = input.report.stderr .. input.report.stdout } } end
					return { result = { ok = not failed, output = table.concat(diagnostics, "\n") } }
				end,
			})
			local format_result = core.task({
				display = `attribute cargo fmt {dir}`, inputs = { report = format.outputs.report, formatted = format.outputs.formatted, manifests = manifests },
				outputs = { formatted = output.artifact(), paths = output.value(), sources_digest = output.value(), check = output.value(), output = output.value() },
				run = function(exec, input)
					local paths, own = {}, {}
					for _, path in ipairs(exec.paths(input.manifests)) do if string.sub(path, -3) == ".rs" and belongs(path, dir) then table.insert(paths, path) end end
					for _, path in ipairs(input.report.unformatted) do if belongs(path, dir) then table.insert(own, path) end end
					local failed = if input.report.check then #own > 0 or (input.report.exit_code ~= 0 and #input.report.unformatted == 0) else input.report.exit_code ~= 0
					return { formatted = input.formatted, paths = paths, sources_digest = exec.digest(input.manifests), check = { requested = input.report.check, failed = failed }, output = input.report.text }
				end,
			})
			local own_runtime = cargo_inputs.cargo_task_inputs({ deps = registry({ dir }, "deps"), test_deps = registry({ dir }, "test_deps"), test_tools = registry({ dir }, "test_tools") })
			local unit = core.task({
				display = `cargo test {dir}`, inputs = merge(merge({ binaries = test_build.outputs.binaries, report = test_build.outputs.report }, own_runtime.bindings("runtime")), own_runtime.bindings("tools")),
				outputs = { units = output.value() },
				run = function(exec, input)
					local units = {}
					for _, bin in ipairs(parse_test_binaries(input.report.stdout, build_dir)) do
						if not workspace or not bin.manifest or belongs(bin.manifest, dir) then
							local args = { exec.path(input.binaries) .. "/" .. bin.path, "--test-threads=1" }
							for _, own in ipairs(helpers.package_specs()) do if own.path == dir then append(args, own.test_args) end end
							local result = exec.action({ display = `test {bin.name}`, argv = args, cache = false, inputs = append({ input.binaries }, own_runtime.resolved(input, "runtime")), allow_failure = true })
							append(units, test.test_vehicle(`{bin.name}:{bin.kind}`, result))
						end
					end
					return { units = units }
				end,
			})
			local doctests = noop(`cargo doctests disabled {dir}`)
			if docs and lib_name(pkg) then
				doctests = core.task({
					display = `attribute cargo doctests {pkg.name}`, inputs = { report = docs.outputs.report }, outputs = { units = output.value() },
					run = function(_exec, input)
						local text = input.report.text
						local failed = string.find(text, `-p {pkg.name} --doc`, 1, true) ~= nil
						local reached = false
						for line in string.gmatch(text, "[^\n]+") do if string.match(line, "^%s*Doc%-tests (%S+)%s*$") == lib_name(pkg) then reached = true end end
						local ok = if workspace then reached and not failed else input.report.exit_code == 0
						return { units = { { name = pkg.name, ok = ok, output = if ok then nil else text .. `\ndoc-tests failed or were never reached for {pkg.name}` } } }
					end,
				}).outputs.units
			end
			children[if workspace then pkg.name else root] = { [lint.LINT] = lint_result.outputs.result, [fmt.FMT] = format_result, [test.TEST] = { unit = unit.outputs.units, doctests = doctests } }
		end
		return children
	end
	local function standalone(spec)
		local discovered = metadata(spec.path, spec)
		return core.expand({ inputs = { metadata = discovered.outputs.metadata }, create = function(input) return create_children(spec.path, spec, input.metadata, false) end })
	end
	local function workspace(root, spec)
		-- Include the effective tool handles and declaration identity. Different
		-- linker or cache settings must not reuse the first member's settings.
		local by_graph = workspace_cache[spec.toolchain]
		if not by_graph then by_graph = {}; workspace_cache[spec.toolchain] = by_graph end
		local by_declaration = by_graph[spec.declaration]
		if not by_declaration then by_declaration = {}; by_graph[spec.declaration] = by_declaration end
		if not by_declaration[root] then
			local discovered = metadata(root, spec)
			by_declaration[root] = core.expand({ inputs = { metadata = discovered.outputs.metadata }, create = function(input) return create_children(root, spec, input.metadata, true) end })
		end
		return by_declaration[root]
	end
	return { workspace = workspace, standalone = standalone }
end
return { new = new, parse_test_binaries = parse_test_binaries }
