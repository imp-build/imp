local core = require("@imp/core")
local cargo = require("@imp/rules/rust/cargo_task_inputs")
return {
 core.test.case("Cargo manifests distinguish recursive workspace and installed sources", function()
  local function paths(handle)
   return core.test.resolve(core.task({ inputs = { src = handle }, outputs = { value = core.output.value() }, run = function(exec, input) return { value = exec.paths(input.src) } end }).outputs.value)
  end
  local shallow = paths(cargo.cargo_manifest_sources("rules/rust/testdata/cargo"))
  local recursive = paths(cargo.cargo_manifest_sources("rules/rust/testdata/cargo", { recursive = true }))
  local builtin = paths(cargo.builtin_cargo_manifest_sources("rust/testdata/cargo", { recursive = true }))
  assert(#shallow == 1 and #recursive == 3 and #builtin == 2)
  assert(string.find(table.concat(builtin, ","), "rust/testdata/cargo/src/lib.rs", 1, true))
 end),
	core.test.case("Cargo roles preserve order and exclude runtime inputs from compilation", function()
		local inputs = cargo.cargo_task_inputs({ deps = { "a", "b" }, test_deps = { "c" }, test_tools = { "t" }, generated_srcs = { { artifact = "g", expected_path = "src/g.rs" } } })
		local compile = inputs.bindings("compile")
		assert(compile.dep1 == "a" and compile.dep2 == "b" and compile.generated1 == "g" and compile.test_dep1 == nil)
		assert(inputs.bindings("runtime").test_dep1 == "c")
		local tools = inputs.bindings("tools")
		assert(tools.tool1 == "t" and tools.generated1 == nil)
		local resolved = inputs.resolved({ dep1 = "A", dep2 = "B", test_dep1 = "C", generated1 = "G" }, "runtime")
		assert(table.concat(resolved, ",") == "A,B,C,G")
	end),
	core.test.case("Cargo generated sources enforce the declared path", function()
		local inputs = cargo.cargo_task_inputs({ generated_srcs = { { artifact = "g", expected_path = "src/g.rs" } } })
		inputs.validate_generated_srcs({ path = function(value) return value end }, { generated1 = "src/g.rs" })
		local ok, err = pcall(inputs.validate_generated_srcs, { path = function(value) return value end }, { generated1 = "bad.rs" })
		assert(not ok and string.find(tostring(err), "does not match", 1, true))
	end),
	core.test.case("Cargo empty inputs produce empty bindings", function()
		local inputs = cargo.cargo_task_inputs()
		assert(next(inputs.bindings("compile")) == nil and #inputs.resolved({}, "runtime") == 0)
	end),
}
