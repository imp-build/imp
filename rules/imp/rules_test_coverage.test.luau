local core = require("@imp/core")
local output = core.output

-- A `core.test_root()` discovers only the `.test.luau` modules directly inside
-- its own BUILD package. Nothing else reports a test module that no root
-- discovers, so this check fails when a module is added without a TEST root
-- in the BUILD module of its directory.

local function directory_of(path)
	return string.match(path, "^(.*)/[^/]+$") or "."
end

--- Return each directory under `rules` that has a `.test.luau` module but no
--- BUILD.luau module that declares `core.test_root()`.
local uncovered = core.task({
	inputs = {
		tests = core.glob({ root = "rules", include = { "**/*.test.luau" } }),
		builds = core.glob({ root = "rules", include = { "**/BUILD.luau" } }),
	},
	outputs = { directories = output.value() },
	run = function(exec, inputs)
		local builds_digest = exec.digest(inputs.builds)
		local rooted = {}
		for _, path in exec.paths(inputs.builds) do
			local source = core.read_file_in_digest(builds_digest, path)
			if string.find(source, "core.test_root()", 1, true) then
				rooted[directory_of(path)] = true
			end
		end
		local seen = {}
		local directories = {}
		for _, path in exec.paths(inputs.tests) do
			local directory = directory_of(path)
			if not rooted[directory] and not seen[directory] then
				seen[directory] = true
				table.insert(directories, directory)
			end
		end
		table.sort(directories)
		return { directories = directories }
	end,
})

return {
	core.test.case("every rules/**/*.test.luau module sits under a TEST root", function()
		local directories = core.test.resolve(uncovered.outputs.directories)
		assert(#directories == 0, "no TEST root in BUILD.luau of: " .. table.concat(directories, ", "))
	end),
}
