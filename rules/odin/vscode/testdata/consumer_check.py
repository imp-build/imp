"""Check Luau IDE generation and the emitted package commands."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    binary = parser.parse_args().imp.resolve()
    env = {**os.environ, "IMP_RUNTIME": "luau"}
    with tempfile.TemporaryDirectory(prefix="imp-vs-consumer-") as directory:
        root = Path(directory)

        def write(path, contents):
            destination = root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents)

        def run(*arguments):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    capture_output=True, timeout=600)
            print("$ " + shlex.join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert result.returncode == 0, result.returncode
            return result.stdout + result.stderr

        def read(path):
            return json.loads((root / path).read_text())

        write("imp.workspace.luau", '''require("@imp/rules/odin/vscode")
return {}
''')
        write("BUILD.luau", '''local odin = require("@imp/rules/odin")
local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")
local shared = c.cc_library({ path = "native", output_name = "answer", shared = true, toolchain = gcc.default_graph_toolchain() })
return {
    app = odin.odin_package({ path = "app" }),
    lib = odin.odin_package({ path = "lib" }),
    tests = odin.odin_test_package({ path = "lib" }),
    bundled = odin.odin_package({ path = "bundled", deps = { shared } }),
}
''')
        write("app/main.odin", "package main\nmain :: proc() {}\n")
        write("lib/lib.odin", "package lib\nValue :: 42\n")
        write("lib/lib_test.odin", '''package lib
import "core:testing"
@(test)
test_value :: proc(t: ^testing.T) { testing.expect(t, true) }
''')
        write("native/answer.c", "int answer(void) { return 42; }\n")
        write("bundled/main.odin", '''package main
foreign import lib "../build/c/libanswer.so"
foreign lib { answer :: proc "c" () -> i32 --- }
main :: proc() { assert(answer() == 42) }
''')
        write(".vscode/settings.json", '{"keep":true}\n')
        write(".vs/keep.txt", "keep\n")
        run("vs", "//...")
        assert not (root / "dist").exists(), "metadata must not publish a build"
        assert read(".vscode/settings.json") == {"keep": True}
        assert list((root / ".vs").iterdir()) == [root / ".vs/keep.txt"]
        files = [".vscode/tasks.json", ".vscode/launch.json"]
        before = {path: (root / path).read_bytes() for path in files}
        run("vs", "//...")
        assert before == {path: (root / path).read_bytes() for path in files}
        tasks = read(".vscode/tasks.json")["tasks"]
        launches = read(".vscode/launch.json")["configurations"]
        assert len(tasks) == 8 and len(launches) == 4
        for task in tasks:
            assert task["args"][0] == "package"
            assert task["args"][3] in ("opt=debug", "opt=release")
            run(*task["args"])
            matching = [item for item in launches if item["preLaunchTask"] == task["label"]]
            for launch in matching:
                executable = root / launch["program"].removeprefix("${workspaceFolder}/")
                assert executable.is_file(), executable
                subprocess.run([str(executable)], cwd=root, env=env, check=True, timeout=30)
        write("app/main.odin", "package main\nValue :: 42\n")
        run("vs", "//...")
        assert len(read(".vscode/launch.json")["configurations"]) == 2
        write("app/main.odin", "package main\nmain :: proc() {}\n")
        run("vs", "//...")
        assert len(read(".vscode/launch.json")["configurations"]) == 4
        print("VS Code consumer check passed", flush=True)


if __name__ == "__main__":
    main()
