-- The Luau workspace of this repository. `imp.workspace.js` stays the default
-- runtime until the Luau catalog cutover is complete. Select this workspace
-- with `IMP_RUNTIME=luau`, for example:
--
--   IMP_RUNTIME=luau imp test //rules/...
--
-- Require each workflow module that a BUILD.luau module uses, so that its
-- goal is registered. Add the modules of each ported rule package here.
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/codegen")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/generate")
require("@imp/rules/workflows/generate_build")
require("@imp/rules/workflows/lint")
require("@imp/rules/workflows/lockfiles")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/publish")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/test")

require("@imp/rules/imp/mode")
require("@imp/rules/c/generate_build")

return { c = { build_generate = true } }
