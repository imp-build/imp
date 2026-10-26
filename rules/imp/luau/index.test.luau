local core = require("@imp/core")
local luau = require("@imp/rules/imp/luau")
local tools = require("@imp/rules/imp/luau/toolchain")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")

local function fails(fn, text)
	local ok, message = pcall(fn)
	assert(not ok and string.find(tostring(message), text, 1, true), tostring(message))
end
local function declare()
	luau.stylua_toolchain("2.6.0", { default = true })
	luau.luau_analyzer_toolchain("0.709", { default = true })
end
return {
	core.test.case("source target selects declared paths and exclusions", function()
		declare()
		local target = luau.luau_sources({ base = "rules/imp/luau", srcs = { "*.luau" }, exclude = { "*.test.luau" } })
		assert(table.isfrozen(target))
		assert(type(target[fmt.FMT]) == "userdata" and type(target[lint.LINT]) == "userdata")
		local paths = core.test.resolve(core.task({
			inputs = { files = target.sources },
			outputs = { value = core.output.value() },
			run = function(exec, input)
				return { value = exec.paths(input.files) }
			end,
		}).outputs.value)
		assert(table.find(paths, "rules/imp/luau/index.luau"))
		assert(not table.find(paths, "rules/imp/luau/index.test.luau"))
		fails(function()
			luau.luau_sources({ srcs = {} })
		end, "non-empty srcs")
	end),
	core.test.case("repository quality target covers maintained Luau files", function()
		declare()
		local repository = require("@workspace/BUILD")
		local paths = core.test.resolve(core.task({
			inputs = {
				selected = repository.luau_sources.sources,
				all = core.files({
					root = ".",
					include = { "**/*.luau" },
					exclude = { "**/target/**", ".imp/**", ".git/**", "**/node_modules/**", "**/dist/**" },
				}),
			},
			outputs = { value = core.output.value() },
			run = function(exec, input)
				return { value = { selected = exec.paths(input.selected), all = exec.paths(input.all) } }
			end,
		}).outputs.value)
		for _, path in ipairs(paths.all) do
			assert(table.find(paths.selected, path), "Luau quality target misses " .. path)
		end
	end),
	core.test.case("empty selections produce passing quality results", function()
		core.test.with_fake_toolchain_host({ os = "linux", arch = "x86_64" }, function()
			declare()
			core.test.with_fake_goal_flags({}, function()
				local target = luau.luau_sources({ srcs = { "missing-luau-source/*.luau" } })
				assert(#core.test.resolve(target[fmt.FMT]).paths == 0)
				local result = core.test.resolve(target[lint.LINT])
				assert(result.ok and not result.fix_applied and #result.paths == 0)
			end)
		end)
	end),
	core.test.case("toolchain graphs defer acquisition and verify downloads", function()
		core.test.with_fake_toolchain_host({ os = "linux", arch = "x86_64" }, function(host)
			declare()
			local tool = tools.stylua.graph().tool
			assert(#host.runs == 0)
			core.test.resolve(core.task({
				inputs = { tool = tool },
				outputs = { value = core.output.value() },
				run = function(exec, input)
					return { value = exec.tool_dir(input.tool) }
				end,
			}).outputs.value)
			assert(#host.runs == 3)
			assert(string.find(host.runs[1].argv[3], "sha256sum -c", 1, true))
			assert(string.find(host.runs[2].argv[3], "unzip", 1, true))
		end)
	end),
	core.test.case("quality roots retain failure diagnostics and check flags", function()
		core.test.with_fake_toolchain_host({ os = "linux", arch = "x86_64" }, function(host)
			declare()
			host.set_run_exit_code("stylua rules/imp/luau", 1)
			host.set_run_stderr("stylua rules/imp/luau", "format difference")
			host.set_run_exit_code("luau-analyze rules/imp/luau", 1)
			host.set_run_stderr("luau-analyze rules/imp/luau", "source.luau:1: UnknownGlobal")
			core.test.with_fake_goal_flags({ check = true, fix = true }, function()
				local target = luau.luau_sources({ base = "rules/imp/luau", srcs = { "index.luau" } })
				local formatted = core.test.resolve(target[fmt.FMT])
				assert(formatted.check.requested and formatted.check.failed)
				assert(formatted.output == "format difference")
				local analyzed = core.test.resolve(target[lint.LINT])
				assert(not analyzed.ok and not analyzed.fix_applied and analyzed.fixed == nil)
				assert(analyzed.output == "source.luau:1: UnknownGlobal")
				local format_action, lint_action
				for _, action in ipairs(host.runs) do
					if action.argv[1] == "stylua" then
						format_action = action
					end
					if action.argv[1] == "luau-analyze" then
						lint_action = action
					end
				end
				assert(format_action and table.find(format_action.argv, "--check"))
				assert(lint_action and table.find(lint_action.argv, "--formatter=gnu"))
				assert(format_action.input_count == 2 and lint_action.input_count == 2)
			end)
		end)
	end),
	core.test.case("platform mappings reject unavailable native analyzers", function()
		assert(#tools.stylua.supported_platforms == 5)
		assert(#tools.analyzer.supported_platforms == 3)
		assert(tools.stylua.artifact_name("2.6.0", { os = "macos", arch = "x86_64" }) == "stylua-macos-x86_64.zip")
		assert(tools.analyzer.artifact_name("0.709", { os = "macos", arch = "aarch64" }) == "luau-macos.zip")
		assert(tools.analyzer.artifact_name("0.709", { os = "windows", arch = "x86_64" }) == "luau-windows.zip")
		fails(function()
			tools.analyzer.artifact_name("0.709", { os = "linux", arch = "aarch64" })
		end, "unsupported luau-analyze toolchain platform")
		fails(function()
			tools.analyzer.artifact_name("0.709", { os = "macos", arch = "x86_64" })
		end, "unsupported luau-analyze toolchain platform")
	end),
}
