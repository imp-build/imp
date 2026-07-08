import { describe, expect, test } from "//rules/imp/test";
import { parseCTestTestfile } from "//rules/c/cmake/ctest_testfile";

// Fixture text mirrors a real `cmake -G Ninja` + `enable_testing()` probe:
// one modern NAME/COMMAND test (resolved to an absolute path) and one
// old-style bare-command test (kept literal, relies on ctest's cwd).
const CTEST_TESTFILE = `# CMake generated Testfile for
# Source directory: /tmp/cmake_probe
# Build directory: /tmp/cmake_probe/build
#
# This file includes the relevant testing commands required for
# testing this directory and lists subdirectories to be tested as well.
add_test([=[mytest_case]=] "/tmp/cmake_probe/build/mytest")
set_tests_properties([=[mytest_case]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/cmake_probe/CMakeLists.txt;8;add_test;/tmp/cmake_probe/CMakeLists.txt;0;")
add_test([=[basic_test]=] "mytest" "--basic")
set_tests_properties([=[basic_test]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/cmake_probe/CMakeLists.txt;9;add_test;/tmp/cmake_probe/CMakeLists.txt;0;")
`;

describe("ctest_testfile parser", () => {
    test("parses a resolved-absolute-path add_test() entry", () => {
        const tests = parseCTestTestfile(CTEST_TESTFILE);
        const mytestCase = tests.find((t) => t.name === "mytest_case");
        expect(mytestCase.command).toEqual(["/tmp/cmake_probe/build/mytest"]);
    });

    test("parses an old-style bare-command add_test() entry with args", () => {
        const tests = parseCTestTestfile(CTEST_TESTFILE);
        const basicTest = tests.find((t) => t.name === "basic_test");
        expect(basicTest.command).toEqual(["mytest", "--basic"]);
    });

    test("ignores set_tests_properties and other file content", () => {
        const tests = parseCTestTestfile(CTEST_TESTFILE);
        expect(tests.length).toBe(2);
    });

    test("returns an empty list for a file with no add_test() calls", () => {
        expect(parseCTestTestfile("# no tests here\n")).toEqual([]);
    });

    test("is case-insensitive and tolerant of extra whitespace before the paren", () => {
        const tests = parseCTestTestfile('ADD_TEST  (  [=[spaced]=] "cmd" )');
        expect(tests).toEqual([{ name: "spaced", command: ["cmd"] }]);
    });
});
