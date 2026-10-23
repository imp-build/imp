local core = require("@imp/core")
local vs = require("@imp/rules/workflows/vs")
local function roots()
	return {
		{ address = "//z:hello", result = { has_main = true } },
		{ address = "//a:hello", result = { has_main = true, executable_path = "output" } },
		{ address = "//:lib", result = { has_main = false } },
		{ address = "//:tests", result = { has_main = true, is_test = true } },
	}
end
return {
	core.test.case("documents use published executables and distinct modes", function()
		core.test.with_fake_toolchain_host(function()
			local files = vs.documents(roots())
			local tasks = files["tasks.json"].tasks
			assert(#tasks == 8 and tasks[1].label == "Build //:lib (Debug)")
			assert(tasks[1].command == "imp" and tasks[1].type == "process")
			assert(tasks[1].args[1] == "package" and tasks[1].args[2] == "//:lib")
			assert(tasks[1].args[4] == "opt=debug" and tasks[2].args[4] == "opt=release")
			local launch = files["launch.json"].configurations
			assert(#launch == 4 and launch[1].type == "lldb-dap")
			assert(launch[1].program == "${workspaceFolder}/dist/a/hello/output")
			assert(launch[3].program == "${workspaceFolder}/dist/z/hello")
			assert(launch[1].preLaunchTask ~= launch[3].preLaunchTask)
			local decoded = core.json_decode(core.json_encode(files["tasks.json"]))
			assert(#decoded.tasks == 8)
			assert(string.find(core.json_encode(files["launch.json"]), '"args": []', 1, true))
		end)
	end),
	core.test.case("Windows documents use the native debugger", function()
		core.test.with_fake_toolchain_host({ os = "windows", arch = "x86_64" }, function()
			local files = vs.documents({ { address = "//:app", result = { has_main = true, executable_path = "output.exe" } } })
			assert(files["launch.json"].configurations[1].type == "cppvsdbg")
			assert(files["launch.json"].configurations[1].program == "${workspaceFolder}/dist/app/output.exe")
		end)
	end),
	core.test.case("goal publishes two files with merge semantics", function()
		core.test.with_fake_write_workspace(function(write)
			assert(vs.graph_vs_goal(roots()) == "Generated 2 VS Code configuration files")
			assert(#write.calls == 1 and write.calls[1].path == ".vscode" and write.calls[1].merge)
			local text = core.read_file_in_digest(write.calls[1].digest, "tasks.json")
			assert(#core.json_decode(text).tasks == 8)
		end)
	end),
	core.test.case("empty selection has JSON arrays", function()
		local files = vs.documents({})
		assert(core.json_encode(files["launch.json"]) == '{\n  "configurations": [],\n  "version": "0.2.0"\n}\n')
	end),
}
