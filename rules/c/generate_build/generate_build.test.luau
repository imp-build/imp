-- Tests of `@imp/rules/c/generate_build`.
--
-- The `testdata` tree has one directory for each case of the generator. No
-- BUILD module uses these files, so they are unowned.
local core = require("@imp/core")
local gcc = require("@imp/rules/c/gcc")
local c = require("@imp/rules/c")
local generate_build = require("@imp/rules/c/generate_build")

local TESTDATA = "rules/c/generate_build/testdata"

--- The targets that the generator gives for the test data, in the
--- `name rule` form, one for each BUILD file. A BUILD file with more than
--- one target fails the test.
local function generated()
	local result = {}
	for file, targets in pairs(generate_build.generate_build({ root = TESTDATA })) do
		assert(#targets == 1, `{file} has {#targets} targets`)
		local only = targets[1]
		assert(next(only.props) == nil, `{file} has props`)
		result[file] = `{only.name} {only.rule}`
	end
	return result
end

local function same(actual, expected)
	for key, value in pairs(expected) do
		assert(actual[key] == value, `{key}: expected {value}, got {tostring(actual[key])}`)
	end
	for key, value in pairs(actual) do
		assert(expected[key] ~= nil, `unexpected {key}: {value}`)
	end
end

local EXPECTED = table.freeze({
	[`{TESTDATA}/1-bad/BUILD.luau`] = "_1_bad cc_library",
	[`{TESTDATA}/app/BUILD.luau`] = "app cc_binary",
	[`{TESTDATA}/cmake_proj/BUILD.luau`] = "cmake_proj_cmake cmake_project",
	[`{TESTDATA}/end/BUILD.luau`] = "_end cc_library",
	[`{TESTDATA}/fake_main/BUILD.luau`] = "fake_main cc_library",
	[`{TESTDATA}/lib/BUILD.luau`] = "lib cc_library",
})

return {
	core.test.suite("has_c_main_entrypoint", {
		core.test.case("finds a main definition", function()
			assert(generate_build.has_c_main_entrypoint("int main(void) { return 0; }\n"))
			assert(generate_build.has_c_main_entrypoint("int main (int argc, char **argv) {}"))
		end),

		core.test.case("finds main at the start of the text", function()
			assert(generate_build.has_c_main_entrypoint("main() {}"))
		end),

		core.test.case("ignores main in comments", function()
			assert(not generate_build.has_c_main_entrypoint("// int main(void)\n"))
			assert(not generate_build.has_c_main_entrypoint("/* int main(void) */\n"))
			assert(not generate_build.has_c_main_entrypoint("/* outer /* main( */ main( */\n"))
		end),

		core.test.case("ignores main in string and character literals", function()
			assert(not generate_build.has_c_main_entrypoint('const char *s = "main(";\n'))
			assert(not generate_build.has_c_main_entrypoint('const char *s = "\\" main(";\n'))
			assert(not generate_build.has_c_main_entrypoint("const char q = '\\''; int x;\n"))
		end),

		core.test.case("ignores a name that ends in main", function()
			assert(not generate_build.has_c_main_entrypoint("int domain(void) { return 0; }\n"))
			assert(not generate_build.has_c_main_entrypoint("int main_loop(void) { return 0; }\n"))
		end),

		core.test.case("finds main after a closed literal and comment", function()
			assert(generate_build.has_c_main_entrypoint('/* a */ const char *s = "x"; int main(void) {}\n'))
		end),
	}),

	core.test.suite("generate_build", {
		core.test.case("gives one target for each unowned source directory and CMake project", function()
			same(generated(), EXPECTED)
		end),

		core.test.case("an exclude list replaces the default", function()
			local result = generate_build.generate_build({ root = TESTDATA, exclude = { "**/app/**" } })
			assert(result[`{TESTDATA}/app/BUILD.luau`] == nil)
			assert(result[`{TESTDATA}/build/BUILD.luau`] ~= nil, "build/ is excluded only by default")
		end),

		core.test.case("skips a directory that a cc_library already declares", function()
			core.test.with_fake_toolchain_host({ os = "linux", arch = "x86_64" }, function()
				c.cc_library({
					path = `{TESTDATA}/lib`,
					toolchain = gcc.toolchain_record(core.native_tool("gcc-toolchain"), "2025.08-1"),
				})
			end)
			local expected = table.clone(EXPECTED)
			expected[`{TESTDATA}/lib/BUILD.luau`] = nil
			same(generated(), expected)
		end),

		core.test.case("the c namespace declares build_generate", function()
			local schema = generate_build.C_CONFIG_SCHEMA
			assert(schema.build_generate ~= nil)
			core.register_build_generator({
				namespace = "c",
				generate = function()
					return {}
				end,
			})
		end),
	}),
}
