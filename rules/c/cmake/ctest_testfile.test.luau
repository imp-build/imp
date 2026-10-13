-- Tests of the CTestTestfile.cmake parser.
local core = require("@imp/core")
local ctest_testfile = require("@imp/rules/c/cmake/ctest_testfile")

-- The text of a real `cmake -G Ninja` + `enable_testing()` probe: one modern
-- NAME/COMMAND test, which CMake resolves to an absolute path, and one
-- old-style bare-command test, which ctest resolves from its build directory.
local CTEST_TESTFILE = [==[# CMake generated Testfile for
# Source directory: /tmp/cmake_probe
# Build directory: /tmp/cmake_probe/build
#
# This file includes the relevant testing commands required for
# testing this directory and lists subdirectories to be tested as well.
add_test([=[mytest_case]=] "/tmp/cmake_probe/build/mytest")
set_tests_properties([=[mytest_case]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/cmake_probe/CMakeLists.txt;8;add_test;/tmp/cmake_probe/CMakeLists.txt;0;")
add_test([=[basic_test]=] "mytest" "--basic")
set_tests_properties([=[basic_test]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/cmake_probe/CMakeLists.txt;9;add_test;/tmp/cmake_probe/CMakeLists.txt;0;")
subdirs("tests")
subdirs("third_party/zlib")
]==]

local function find_test(tests, name)
	for _, entry in ipairs(tests) do
		if entry.name == name then
			return entry
		end
	end
	return nil
end

local function same_list(actual, expected)
	if #actual ~= #expected then
		return false
	end
	for i, value in ipairs(expected) do
		if actual[i] ~= value then
			return false
		end
	end
	return true
end

return {
	core.test.suite("ctest_testfile parser", {
		core.test.case("parses a resolved-absolute-path add_test() entry", function()
			local entry = find_test(ctest_testfile.parse_ctest_testfile(CTEST_TESTFILE), "mytest_case")
			assert(entry ~= nil)
			assert(same_list(entry.command, { "/tmp/cmake_probe/build/mytest" }))
		end),

		core.test.case("parses an old-style bare-command add_test() entry with args", function()
			local entry = find_test(ctest_testfile.parse_ctest_testfile(CTEST_TESTFILE), "basic_test")
			assert(entry ~= nil)
			assert(same_list(entry.command, { "mytest", "--basic" }))
		end),

		core.test.case("ignores set_tests_properties and other file content", function()
			assert(#ctest_testfile.parse_ctest_testfile(CTEST_TESTFILE) == 2)
		end),

		core.test.case("returns an empty list for a file with no add_test() calls", function()
			assert(#ctest_testfile.parse_ctest_testfile("# no tests here\n") == 0)
		end),

		core.test.case("is case-insensitive and tolerant of extra whitespace before the paren", function()
			local tests = ctest_testfile.parse_ctest_testfile('ADD_TEST  (  [=[spaced]=] "cmd" )')
			assert(#tests == 1)
			assert(tests[1].name == "spaced")
			assert(same_list(tests[1].command, { "cmd" }))
		end),

		core.test.case("reads an escaped quote in a double-quoted token", function()
			local tests = ctest_testfile.parse_ctest_testfile('add_test(quoted "say \\"hi\\"")')
			assert(tests[1].command[1] == 'say "hi"', tests[1].command[1])
		end),

		core.test.case("lists subdirs() entries in file order", function()
			assert(same_list(ctest_testfile.parse_subdirs(CTEST_TESTFILE), { "tests", "third_party/zlib" }))
			assert(#ctest_testfile.parse_subdirs("# none\n") == 0)
		end),
	}),
}
