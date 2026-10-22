local core = require("@imp/core")
local project = require("@imp/rules/python/project")
local workspace = require("@imp/rules/python/workspace")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local function fails(fn, expected)
	local ok, message = pcall(fn)
	assert(not ok and string.find(tostring(message), expected, 1, true), tostring(message))
end
return {
	core.test.case("project paths and workspace identity", function()
		local ref = project.python_workspace_ref("./rules//python/testdata/workspace/")
		local member = project.python_project({ workspace = ref, path = "packages/app" })
		assert(member.path == "rules/python/testdata/workspace/packages/app")
		assert(member.workspace.path == ref.path and table.isfrozen(member))
		assert(project.python_project({ workspace = ref, path = "." }).path == ref.path)
		assert(project.python_project({ workspace = ref, path = member.path }).path == member.path)
	end),
	core.test.case("infer nearest project and enclosing workspace", function()
		local member = project.infer_python_project("rules/python/testdata/workspace/packages/app/src", "python_app")
		assert(member.path == "rules/python/testdata/workspace/packages/app")
		assert(member.workspace.path == "rules/python/testdata/workspace")
		local standalone = project.infer_python_project("rules/python/example/src/hello", "python_app")
		assert(standalone.path == "rules/python/example" and standalone.workspace.path == standalone.path)
		fails(function() project.infer_python_project("rules/python", "python_app") end, "No pyproject.toml found")
	end),
	core.test.case("reject invalid project and workspace declarations", function()
		fails(function() project.python_workspace_ref("../python") end, "stay in the workspace")
		fails(function() project.python_project({ path = "." }) end, "expects python_workspace")
		fails(function() project.python_project({ workspace = project.python_workspace_ref("."), path = "../other" }) end, "stay in the workspace")
	end),
	core.test.case("workspace exports lock root", function()
		local value = workspace.python_workspace({ path = "rules/python/example" })
		assert(value.__python_workspace and value[lockfiles.GEN_LOCKFILES] ~= nil)
	end),
}
