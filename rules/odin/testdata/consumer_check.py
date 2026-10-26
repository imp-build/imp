"""Check the Luau Odin rules with real actions in an external workspace."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

WORKSPACE = '''local core = require("@imp/core")
require("@imp/rules/odin")
require("@imp/rules/odin/odinfmt")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/test")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/lint")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/generate_build")
require("@imp/rules/workflows/lockfiles")
core.define_profile("shipping", { opt = "release", odin = { defines = { SHIPPING = "true" } } })
return { odin = { build_generate = true } }
'''
BUILD = '''local core = require("@imp/core")
local odin = require("@imp/rules/odin")
local fmt = require("@imp/rules/odin/odinfmt")
local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")
local cmake = require("@imp/rules/c/cmake")
local codegen = require("@imp/rules/imp/codegen")
local compiler = odin.odin_toolchain("dev-2026-03", { default = true, lockfile = "@workspace/locks/odin.lock" })
fmt.odinfmt_toolchain(nil, { lockfile = "@workspace/locks/odinfmt.lock" })
local generated = codegen.stamp_file({ output = "generated/value.odin", text = "package generated\\nGeneratedValue :: 42" })
local static = c.cc_library({ path = "nativec", output_name = "native", toolchain = gcc.default_graph_toolchain() })
local shared = c.cc_library({ path = "nativec", output_name = "shared", shared = true, toolchain = gcc.default_graph_toolchain() })
local project = cmake.cmake_project({ path = "cmake", build_dir = "build/cmake" })
local cmake_dep = cmake.cmake_library_dep(project, "native")
-- Declare the consumer before its imported dependency.
local app = odin.odin_package({ path = "app", toolchain = compiler })
local lib = odin.odin_package({ path = "lib" })
return {
    app = app, lib = lib,
    tests = odin.odin_test_package({ path = "lib", deps = { lib } }),
    generated = odin.odin_package({ path = "generated", generated_srcs = { { artifact = generated.file, path = "value.odin" } } }),
    collection = odin.odin_package({ path = "collection/app", collections = { local_lib = "collection/vendor" } }),
    native = odin.odin_package({ path = "native", deps = { static } }),
    shared = odin.odin_package({ path = "shared", deps = { shared } }),
    shared_tests = odin.odin_test_package({ path = "shared", srcs = { "*.odin" }, deps = { shared } }),
    cmake = odin.odin_package({ path = "uses_cmake", deps = { cmake_dep } }),
    locks = odin.odin_gen_lockfiles(), fmt_locks = fmt.odinfmt_gen_lockfiles(),
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-odin-consumer-") as directory:
        root = Path(directory)

        def write(path, text):
            dest = root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text)

        def run(*arguments, expected=None, failure=False):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True, timeout=600)
            text = result.stdout + result.stderr
            print("$ " + shlex.join(command), flush=True)
            print(text, flush=True)
            assert (result.returncode != 0) == failure, result.returncode
            if expected:
                assert expected in text, text
            return text

        write("imp.workspace.luau", WORKSPACE)
        write("BUILD.luau", BUILD)
        write("locks/odin.lock", (rules / "odin/odin.lock").read_text())
        write("locks/odinfmt.lock", (rules / "odin/odinfmt/odinfmt.lock").read_text())
        write("app/main.odin", '''package main
import "core:fmt"
import "core:os"
import "../lib"
SHIPPING :: #config(SHIPPING, false)
main :: proc() {
    fmt.println("value", lib.Value, "shipping", SHIPPING)
    for arg in os.args[1:] {
        fmt.println("arg", arg)
        if arg == "fail" {
            os.exit(9)
        }
    }
}
''')
        write("lib/lib.odin", "package lib\nValue :: 41\n")
        write("lib/lib_test.odin", '''package lib
import "core:testing"
@(test)
test_value :: proc(t: ^testing.T) { testing.expect(t, Value == 41) }
''')
        write("generated/main.odin", '''package generated
import "core:fmt"
main :: proc() { fmt.println("generated", GeneratedValue) }
''')
        write("collection/app/main.odin", '''package main
import "core:fmt"
import "local_lib:greet"
main :: proc() { fmt.println("collection", greet.Value) }
''')
        write("collection/vendor/greet/greet.odin", 'package greet\nimport "local_lib:util"\nValue :: util.Value\n')
        write("collection/vendor/util/util.odin", "package util\nValue :: 42\n")
        write("nativec/add.c", "int answer(void) { return 42; }\n")
        native = '''package main
import "core:fmt"
foreign import lib "../ARCHIVE"
foreign lib { answer :: proc "c" () -> i32 --- }
main :: proc() { assert(answer() == 42); fmt.println("native", answer()) }
'''
        write("native/main.odin", native.replace("ARCHIVE", "build/c/native.a"))
        write("shared/main.odin", native.replace("ARCHIVE", "build/c/libshared.so"))
        write("shared/shared_test.odin", '''package main
import "core:testing"
@(test)
test_answer :: proc(t: ^testing.T) { testing.expect(t, answer() == 42) }
''')
        write("cmake/add.c", "int answer(void) { return 42; }\n")
        write("cmake/CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(native C)\nadd_library(native STATIC add.c)\n")
        write("uses_cmake/main.odin", native.replace("ARCHIVE", "build/cmake/libnative.a"))

        run("build", "//:app", "//:generated", "//:collection", "//:native", "//:shared", "//:cmake")
        run("run", "//:app", "--", "one", "two words", expected="arg two words")
        run("run", "//:app", "--", "fail", failure=True, expected="exit code 9")
        run("run", "--profile", "shipping", "//:app", expected="shipping true")
        run("run", "--axis", "opt=release", "//:app", expected="value 41")
        run("run", "//:generated", expected="generated 42")
        run("run", "//:collection", expected="collection 42")
        run("run", "//:native", expected="native 42")
        run("run", "//:shared", expected="native 42")
        run("run", "//:cmake", expected="native 42")
        run("test", "//:tests", "//:shared_tests")
        run("lint", "//:app", "//:lib", "//:tests")
        run("package", "//:shared")
        assert (root / "dist/shared/output").is_file()
        assert (root / "dist/shared/libshared.so").is_file()
        run("fmt", "--check", "//:app", failure=True)
        run("fmt", "//:app", "//:lib", "//:tests")
        run("fmt", "--check", "//:app", "//:lib", "//:tests")
        write("odinfmt.json", '{}\n')
        run("fmt", "--check", "//:app")
        write("lib/lib.odin", "package lib\nValue :: 42\n")
        run("run", "//:app", expected="value 42")
        run("test", "//:tests", failure=True)
        write("lib/lib.odin", "package lib\nValue :: 41\n")
        write("new/main.odin", 'package main\nimport "core:fmt"\nmain :: proc() { fmt.println("generated BUILD") }\n')
        run("goal", "generate-build", "--check", failure=True, expected="out of date")
        run("goal", "generate-build")
        run("goal", "generate-build", "--check")
        run("run", "//new:new", expected="generated BUILD")
        generated_build = (root / "new/BUILD.luau").read_text()
        write("new/main_test.odin", 'package main\nimport "core:testing"\n@(test) check :: proc(t: ^testing.T) {}\n')
        run("goal", "generate-build")
        run("goal", "generate-build")
        run("goal", "generate-build", "--check")
        assert (root / "new/BUILD.luau").read_text() == generated_build
        run("run", "//new:new", expected="generated BUILD")
        write("app/missing.odin", 'package main\nimport "../missing"\n')
        run("build", "//:app", failure=True, expected="there is no Odin package there")
        (root / "app/missing.odin").unlink()
        write("BUILD.luau", BUILD.replace('local lib = odin.odin_package({ path = "lib" })', 'local lib = odin.odin_package({ path = "lib", defines = { A = "1" } })').replace('path = "app", toolchain = compiler', 'path = "app", toolchain = compiler, defines = { A = "2" }'))
        run("build", "//:app", failure=True, expected="conflicting define")
        write("BUILD.luau", BUILD.replace('path = "value.odin"', 'path = "wrong.odin"'))
        run("build", "//:generated", failure=True, expected="does not match its declared path")
        write("BUILD.luau", BUILD)
        # Regenerate the platform matrix to verify selectable publication.
        run("goal", "gen-lockfiles", "//:locks", "//:fmt_locks")
        assert json.loads((root / "locks/odin.lock").read_text())["tool"] == "odin"
        assert json.loads((root / "locks/odinfmt.lock").read_text())["tool"] == "odinfmt"
        assert not (root / "build").exists()
    print("Luau Odin consumer check passed")


if __name__ == "__main__":
    main()
