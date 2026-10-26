-- The `run` goal starts one program from a selected `RUN` root. This module
-- owns the common policy, and `core.run_program` applies it: the program is
-- impure, runs in a sandbox, starts in the real workspace, streams its
-- output, and receives the CLI arguments after `--`.
--
-- A `RUN` root resolves to one of these shapes:
--
--   { argv, env?, display?, tools?, inputs }   a core.program description
--   { argv, env?, display?, tools?, digest }   a legacy single-digest description
--   { digest, path }                           one built executable artifact
--   { executable, executable_path? }           one executable with its path
--
-- The goal stages the description inputs or the artifact digest. It
-- does not write the program into the workspace.
local core = require("@imp/core")

-- The workspace is the working directory, so a relative path finds workspace
-- files, not staged files. The launcher thus starts the staged executable
-- through its absolute path under `$IMP_SANDBOX_ROOT`. `$1` is the path of
-- the executable in the digest, and `shift` removes it, so that the CLI
-- arguments arrive as "$@". `exec` replaces the shell, so the exit code and
-- signals (for example Ctrl-C) go directly to the program.
local LAUNCH_STAGED = 'prog=$1; shift; exec "$IMP_SANDBOX_ROOT/$prog" "$@"'

--- Return the `core.run_program` options for one resolved `RUN` root.
local function program_for(address, result)
	if type(result) ~= "table" then
		core.goal_error(`{address}: run graph root must return an executable artifact`)
	end
	-- A full program description owns its argv. Its argv refers to workspace
	-- paths or to staged paths under `$IMP_SANDBOX_ROOT`.
	if type(result.argv) == "table" then
		if type(result.digest) ~= "string" and type(result.inputs) ~= "table" then
			core.goal_error(
				`{address}: a run graph root that describes a program must supply inputs or a digest to stage`
			)
		end
		return {
			argv = result.argv,
			env = result.env,
			tools = result.tools,
			inputs = result.inputs or { result.digest },
			display = result.display or `run {address}`,
		}
	end
	local executable = result.executable or result
	if type(executable) ~= "table" then
		core.goal_error(`{address}: run graph root must return an executable artifact`)
	end
	local executable_path = result.executable_path or executable.path
	if type(executable.digest) ~= "string" or type(executable_path) ~= "string" then
		core.goal_error(`{address}: run graph root must return an executable artifact`)
	end
	return {
		argv = { "sh", "-c", LAUNCH_STAGED, `run {address}`, executable_path },
		inputs = { executable.digest },
		display = `run {address}`,
	}
end

--- Run the program of the one selected `RUN` root.
local function graph_run_goal(roots)
	if #roots ~= 1 then
		local addresses = {}
		for _, root in ipairs(roots) do
			table.insert(addresses, root.address)
		end
		core.goal_error(`run requires a single target, got {#roots}: {table.concat(addresses, ", ")}`)
	end
	local root = roots[1]
	-- A root can run its program itself as an uncached task, for example when
	-- a runtime tool must wrap an artifact. Such a root has no result.
	if root.result == nil or (type(root.result) == "table" and next(root.result) == nil) then
		return nil
	end
	core.run_program(program_for(root.address, root.result))
	return nil
end

return {
	RUN = core.goal("run", graph_run_goal),
	graph_run_goal = graph_run_goal,
}
