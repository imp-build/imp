local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")
local workflow = require("@imp/rules/workflows/generate")
return {
    docs_workflow = { [workflow.GENERATE] = generate.generated_files({
        display = "generate GitHub workflows",
        tools = { python3 = core.native_tool("python3") },
        inputs = { script = core.files({ paths = { "ci/gen_workflow.py" } }) },
        output_paths = { ".github/workflows/docs.yml", ".github/workflows/release.yml" },
        argv = function() return { "python3", "ci/gen_workflow.py", ".github/workflows/docs.yml", ".github/workflows/release.yml" } end,
    }) },
}
