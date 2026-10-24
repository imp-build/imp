-- Regenerate every shipped toolchain lockfile to its registered versions.
-- Import each toolchain so that it registers its lockfile before invocation.
local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")

require("@imp/rules/c/cmake")
require("@imp/rules/c/gcc")
require("@imp/rules/c/mold")
require("@imp/rules/c/msvc")
require("@imp/rules/c/zig")
require("@imp/rules/js/biome/toolchain")
require("@imp/rules/js/node/toolchain")
require("@imp/rules/js/pnpm/toolchain")
require("@imp/rules/oci/toolchain")
require("@imp/rules/odin/toolchain")
require("@imp/rules/odin/odinfmt/toolchain")
require("@imp/rules/python/pex_toolchain")
require("@imp/rules/python/ruff_toolchain")
require("@imp/rules/python/uv_toolchain")
require("@imp/rules/rust/kache/toolchain")
require("@imp/rules/rust/toolchain")
require("@imp/rules/zola")

--- Declare one authoritative regeneration task for each registered lockfile.
local function builtin_lockfile_roots()
	local specs = lockfiles.builtin_lockfiles()
	assert(#specs > 0, "no builtin lockfiles registered; did the toolchain module imports change?")
	local roots = {}
	for _, spec in ipairs(specs) do
		table.insert(roots, { address = spec.lockfile, root = lockfiles.generate_builtin_lockfile(spec) })
	end
	return roots
end

return {
	GEN_BUILTIN_LOCKFILES = core.goal("gen-builtin-lockfiles", lockfiles.graph_gen_lockfiles_goal, {
		selection = "none",
		roots = builtin_lockfile_roots,
	}),
	builtin_lockfile_roots = builtin_lockfile_roots,
}
