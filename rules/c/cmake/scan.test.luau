local core = require("@imp/core")
local ninja = require("./ninja_graph")
local replay = require("./graph_replay")

local ROOT = "cmake-scan-fixture"
local BUILD_DIR = `{ROOT}/build`
local SOURCE = `{ROOT}/source.c`
local HEADER = `{ROOT}/used.h`
local BUILD_NINJA = [[include CMakeFiles/rules.ninja
build obj: C_COMPILER__probe /oldroot/cmake-scan-fixture/source.c
  DEP_FILE = obj.d

build build.ninja: RERUN_CMAKE /missing-configure-input

]]
local RULES_NINJA = [[rule C_COMPILER__probe
  command = sh ../compiler.sh $DEP_FILE
  depfile = $DEP_FILE
  deps = gcc

rule RERUN_CMAKE
  command = false
  generator = 1

]]

-- Use real actions and Ninja. The small compiler substitute writes a depfile,
-- so these tests do not need a downloaded C compiler.
local function scan_fixture(mode)
	local build_text = BUILD_NINJA
	local rules_text = RULES_NINJA
	local is_msvc = mode == "msvc headers" or mode == "msvc no headers"
	local compiler = 'test "$2" = -fsyntax-only || exit 9; printf "obj: ../source.c ../used.h\\n" > "$1"'
	if is_msvc then
		rules_text = string.gsub(rules_text, "deps = gcc", "deps = msvc")
		compiler = 'test "$2" = /Zs || exit 9; '
			.. if mode == "msvc headers" then 'printf "Note: including file: ../used.h\\n"' else "true"
	elseif mode == "compiler failure" then
		compiler = "echo scan-compiler-failed >&2; exit 7"
	elseif mode == "missing depfile" then
		compiler = "true"
	elseif mode == "invalid graph" then
		build_text = "invalid ninja syntax\n"
	elseif mode == "no targets" then
		build_text = "build obj: phony\n"
	elseif mode == "patch failure" then
		rules_text = ""
	end
	local graph = ninja.parse_ninja(BUILD_NINJA, function()
		return if is_msvc then rules_text else RULES_NINJA
	end)
	graph.sandbox_root = "/oldroot"
	local configured = core.task({
		inputs = { mkdir = core.native_tool("mkdir") },
		outputs = {
			directory = core.output.artifact(),
			ninja_graph = core.output.value(),
			source_paths = core.output.value(),
		},
		run = function(exec)
			local result = exec.action({
				argv = {
					"sh",
					"-c",
					'set -eu; mkdir -p "$1/build/CMakeFiles"; '
						.. 'printf "%s" "$2" > "$1/build/build.ninja"; '
						.. 'if [ -n "$3" ]; then printf "%s" "$3" > "$1/build/CMakeFiles/rules.ninja"; fi; '
						.. 'printf "%s" "$4" > "$1/compiler.sh"; '
						.. ': > "$1/source.c"; : > "$1/used.h"; : > "$1/unused.h"',
					"scan-fixture",
					ROOT,
					build_text,
					rules_text,
					compiler,
				},
				outputs = { directory = core.output.directory(ROOT) },
			})
			return {
				directory = result.outputs.directory,
				ninja_graph = graph,
				source_paths = { SOURCE, HEADER, `{ROOT}/unused.h` },
			}
		end,
	})
	return replay.scan_cmake_compiler_inputs({
		path = ROOT,
		build_dir_path = BUILD_DIR,
		srcs_input = configured.outputs.directory,
		dir_inputs = {},
		dir_keys = {},
		deps = {},
		toolchain = {
			kind = if is_msvc then "msvc-host-toolchain" else "gcc",
			task_inputs = function()
				return { sh = core.native_tool("sh") }
			end,
			resolve_state = function()
				return nil
			end,
			edge_env = function()
				return {}
			end,
		},
	}, configured).outputs.manifest
end

local cases = {
	core.test.case("runs Ninja and removes the configure regeneration edge", function()
		local manifest = core.test.resolve(scan_fixture("success"))
		assert(#manifest.obj.headers == 1)
		assert(manifest.obj.headers[1] == HEADER)
	end),
	core.test.case("accepts MSVC headers without a direct source in the record", function()
		local manifest = core.test.resolve(scan_fixture("msvc headers"))
		assert(#manifest.obj.headers == 1)
		assert(manifest.obj.headers[1] == HEADER)
	end),
	core.test.case("accepts an MSVC record with no headers", function()
		local manifest = core.test.resolve(scan_fixture("msvc no headers"))
		assert(#manifest.obj.headers == 0)
	end),
}
for _, mode in { "compiler failure", "missing depfile", "invalid graph", "no targets", "patch failure" } do
	table.insert(
		cases,
		core.test.case(`rejects {mode}`, function()
			local ok, err = pcall(core.test.resolve, scan_fixture(mode))
			assert(not ok, `scan accepted {mode}`)
			local text = tostring(err)
			if mode == "missing depfile" then
				assert(string.find(text, "Ninja dependency record omitted the direct source", 1, true), text)
			else
				assert(string.find(text, "failed with exit code", 1, true), text)
				if mode == "compiler failure" then
					assert(string.find(text, "scan-compiler-failed", 1, true), text)
				elseif mode == "no targets" then
					assert(string.find(text, "cmake dependency scan found no compiler targets", 1, true), text)
				end
			end
		end)
	)
end

return { core.test.suite("compiler scan actions", cases) }
