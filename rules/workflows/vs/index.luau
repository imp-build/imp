-- Generate IDE configuration from the metadata of the selected packages.
local core = require("@imp/core")
local function array() return core.json_decode("[]") end
local function documents(roots)
	roots = table.clone(roots)
	table.sort(roots, function(a, b) return a.address < b.address end)
	local launch_vsc = { version = "0.2.0", configurations = array() }
	local tasks_vsc = { version = "2.0.0", tasks = array() }
	local is_windows = core.platform_info().os == "windows"
	for _, root in ipairs(roots) do
		local address, info = root.address, root.result
		local directory, target = string.match(address, "^//(.*):([^:]+)$")
		assert(target ~= nil, `invalid Odin target address '{address}'`)
		local published = "dist/" .. (if directory == "" then "" else directory .. "/") .. target
		local executable = published .. (if info.executable_path then "/" .. info.executable_path else "")
		for _, mode in ipairs({ "debug", "release" }) do
			local label = address .. " (" .. (if mode == "debug" then "Debug" else "Release") .. ")"
			local task = "Build " .. label
			local args = { "package", address, "--axis", "opt=" .. mode }
			table.insert(tasks_vsc.tasks, { label = task, type = "process", command = "imp", args = args, group = "build", problemMatcher = array() })
			if info.has_main and not info.is_test then
				table.insert(launch_vsc.configurations, { name = label, type = if is_windows then "cppvsdbg" else "lldb-dap",
					request = "launch", program = "${workspaceFolder}/" .. executable, args = array(), stopAtEntry = false,
					cwd = "${workspaceFolder}", environment = array(), externalConsole = false, preLaunchTask = task })
			end
		end
	end
	return { ["launch.json"] = launch_vsc, ["tasks.json"] = tasks_vsc }
end
--- Write two VS Code configuration files and preserve other workspace files.
local function graph_vs_goal(roots)
	local files = {}
	for path, value in pairs(documents(roots)) do files[path] = core.json_encode(value) end
	core.write_workspace(".vscode", core.digest_from_text(files), { merge = true })
	return "Generated 2 VS Code configuration files"
end
return { VSCODE = core.goal("vs", graph_vs_goal), graph_vs_goal = graph_vs_goal, documents = documents }
