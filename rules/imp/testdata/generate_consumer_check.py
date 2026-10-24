"""Check Luau generation, drift, cache reuse, and a mounted formatter."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


WORKSPACE = '''require("@imp/rules/workflows/generate")
return {}
'''
BUILD = '''local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")
local workflow = require("@imp/rules/workflows/generate")
local odin = require("@imp/rules/odin/toolchain")
local fmt = require("@imp/rules/odin/odinfmt/toolchain")
odin.odin_toolchain("dev-2026-03", { default = true })
local formatter = fmt.odinfmt_toolchain("dev-2026-03")
return {
    files = { [workflow.GENERATE] = generate.generated_files({
        display = "generate two files",
        tools = { sh = core.native_tool("sh") },
        inputs = { source = core.files({ include = { "source.txt" } }) },
        output_paths = { "gen/a.txt", "gen/nested/b.txt" },
        argv = function()
            return { "sh", "-c", 'read -r value < source.txt; printf "%s\\n" "$value" > gen/a.txt; printf "%s\\n" second > gen/nested/b.txt' }
        end,
    }) },
    formatted = { [workflow.GENERATE] = generate.generated_files({
        display = "generate formatted Odin",
        tools = { sh = core.native_tool("sh"), cp = core.native_tool("cp"), formatter = formatter.tool },
        inputs = { source = core.files({ include = { "source.odin" } }) },
        output_paths = { "gen/formatted.odin" },
        argv = function(exec, inputs)
            return { "sh", "-c", 'cp source.odin gen/formatted.odin && "$1" -w gen/formatted.odin', "generate", fmt.bin(exec, inputs.formatter) }
        end,
    }) },
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    binary = parser.parse_args().imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-generate-consumer-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text(WORKSPACE)
        (root / "BUILD.luau").write_text(BUILD)
        (root / "source.txt").write_text("first\n")
        source = "package generated\n\nvalue :: proc() -> int {\nreturn 42\n}\n"
        (root / "source.odin").write_text(source)
        sentinel = root / "unrelated.txt"
        sentinel.write_text("keep\n")

        def run(*arguments, failure=False, expected=None, cached=False):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    capture_output=True, timeout=600)
            output = result.stdout + result.stderr
            print("$ " + shlex.join(command), flush=True)
            print(output, flush=True)
            assert (result.returncode != 0) == failure, result.returncode
            if expected is not None:
                assert expected in output, output
            if cached:
                summary = re.search(r"sandboxes:\s+\d+ \((\d+) fresh, (\d+) cached\)", output)
                assert summary is not None, output
                assert int(summary[1]) == 0 and int(summary[2]) > 0, output
            assert sentinel.read_text() == "keep\n"
            return output

        a, b = root / "gen/a.txt", root / "gen/nested/b.txt"
        run("generate", "--check", "//:files", failure=True,
            expected="generated files are out of date")
        assert not a.exists() and not b.exists()
        run("generate", "//:files", cached=True)
        assert a.read_text() == "first\n" and b.read_text() == "second\n"
        run("generate", "--check", "//:files", expected="2 generated file(s) up to date", cached=True)
        a.write_text("drift\n")
        output = run("generate", "--check", "//:files", failure=True, cached=True)
        assert "gen/a.txt" in output and "gen/nested/b.txt" not in output, output
        assert a.read_text() == "drift\n" and b.read_text() == "second\n"
        run("generate", "//:files", cached=True)
        assert a.read_text() == "first\n" and b.read_text() == "second\n"
        (root / "source.txt").write_text("changed\n")
        run("generate", "//:files")
        assert a.read_text() == "changed\n" and b.read_text() == "second\n"
        run("generate", "--check", "//:files", cached=True)

        formatted = root / "gen/formatted.odin"
        run("generate", "--check", "//:formatted", failure=True,
            expected="gen/formatted.odin")
        assert not formatted.exists()
        run("generate", "//:formatted", cached=True)
        assert formatted.read_text() == "package generated\n\nvalue :: proc() -> int {\n\treturn 42\n}\n"
        assert (root / "source.odin").read_text() == source
        run("generate", "--check", "//:formatted", expected="1 generated file(s) up to date", cached=True)
    print("Luau generate consumer check passed")


if __name__ == "__main__":
    main()
