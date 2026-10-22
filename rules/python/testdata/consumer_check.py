"""Check documented Python Luau targets and real core rule consumers."""
import argparse
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


def check_core(binary, rules):
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-python-core-consumer-") as directory:
        root = Path(directory)
        shutil.copytree(rules / "python/example", root, dirs_exist_ok=True)
        # The temporary workspace owns these declarations; retain the fixture locks.
        (root / "BUILD.js").unlink()
        shutil.copytree(rules / "python/testdata/native_wheel", root / "native")
        shutil.copytree(rules / "python/testdata/workspace", root / "members")
        # A separate workspace is required to exercise a script without a pyproject.
        standalone = root / "standalone"
        standalone.mkdir()
        (standalone / "imp.workspace.luau").write_text('require("@imp/rules/workflows/run")\nreturn {}\n')
        (standalone / "BUILD.luau").write_text('return { scripts = require("@imp/rules/python").python_sources({ root = "tools" }) }\n')
        (standalone / "tools").mkdir()
        (standalone / "tools/demo.py").write_text('import sys; print("standalone:" + "|".join(sys.argv[1:]))\n')
        (root / "imp.workspace.luau").write_text('''require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/test")
return {}
''')
        (root / "BUILD.luau").write_text('''local python = require("@imp/rules/python")
return {
    app = python.python_app({ entry_point = "hello.__main__", sources = { "src/**/*.py" } }),
    tests = python.python_test({ sources = { "tests/**/*.py" } }),
    scripts = python.python_sources({ root = "scripts" }),
    member = python.python_test({ base = "members/packages/app", sources = { "tests/**/*.py" } }),
}
''')
        (root / "native/BUILD.luau").write_text('''local python = require("@imp/rules/python")
return {
    app = python.python_app({ entry_point = "native_app.__main__", sources = { "src/**/*.py" } }),
    tests = python.python_test({ sources = { "tests/**/*.py" } }),
}
''')
        main_file = root / "src/hello/__main__.py"
        with main_file.open("a") as stream:
            stream.write('\nimport sys\nprint("args:" + "|".join(sys.argv[1:]))\nif "fail" in sys.argv: sys.exit(9)\n')

        def run(*arguments, expected=None, failure=False, cwd=root):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=600)
            print("$ " + shlex.join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert (result.returncode != 0) if failure else (result.returncode == 0), result.returncode
            if expected:
                assert expected in result.stdout + result.stderr, result.stdout + result.stderr
            return result

        run("targets", "//:member", expected="test")
        run("build", "//:app", "//native:app")
        run("package", "//:app")
        assert (root / "dist/app").is_file()
        run("run", "//:app", "--", "one", "two words", expected="args:one|two words")
        run("run", "//:app", "--", "fail", failure=True, expected="exit code 9")
        run("run", "//native:app", expected="native wheel ok: build=3.13.0")
        run("test", "//:tests", "//native:tests")
        run("run", "//:scripts#scripts/demo.py", "--", "one", "two words", expected="demo script args: one two words")
        run("run", "//:scripts#tools/demo.py", "--", "one", "two words", cwd=standalone, expected="standalone:one|two words")
        with main_file.open("a") as stream:
            stream.write('print("source edited")\n')
        run("run", "//:app", expected="source edited")
        (root / "tests/test_failure.py").write_text('def test_failure():\n    assert False, "consumer failure"\n')
        run("test", "//:tests", failure=True, expected="consumer failure")
        assert not (root / ".venv").exists()
        assert not (root / "native/.venv").exists()
        assert not (root / ".imp-out").exists()
        assert not (root / ".imp-pex-sources").exists()
    print("Python Luau core consumer check passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    guide = (rules / "python/DOC.md").read_text(encoding="utf-8")
    sections = guide.split("## Use the Luau toolchains\n")
    if len(sections) != 2:
        raise AssertionError("Expected one Luau toolchain section in the guide")
    section = sections[1].split("\n## ", 1)[0]
    blocks = re.findall(r"^```lua\n(.*?)^```$", section, re.MULTILINE | re.DOTALL)
    if len(blocks) != 2:
        raise AssertionError("Expected workspace and BUILD Lua blocks in the guide")
    commands = [
        shlex.split(block.strip())
        for block in re.findall(r"^```sh\n(.*?)^```$", section, re.MULTILINE | re.DOTALL)
        if block.strip().startswith("IMP_RUNTIME=luau imp goal gen-lockfiles")
    ]
    if len(commands) != 1:
        raise AssertionError("Expected one Luau lockfile generation command in the guide")
    command = commands[0]
    assert command[:4] == ["IMP_RUNTIME=luau", "imp", "goal", "gen-lockfiles"], command
    selectors = command[4:]
    assert selectors == ["//:pex", "//:uv"], selectors
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-python-doc-consumer-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text(blocks[0], encoding="utf-8")
        (root / "BUILD.luau").write_text(blocks[1], encoding="utf-8")
        check = [str(binary), "targets", *selectors]
        result = subprocess.run(check, cwd=root, env=env, text=True, capture_output=True, timeout=30)
        print("$ " + shlex.join(check), flush=True)
        print(result.stdout + result.stderr, flush=True)
        print(f"exit: {result.returncode}", flush=True)
        assert result.returncode == 0, result.returncode
        expected = {selector: ["gen-lockfiles"] for selector in selectors}
        targets = {}
        current = None
        for line in result.stdout.splitlines():
            if line.startswith("//"):
                current = line.removesuffix(" (graph)")
                assert current not in targets, line
                targets[current] = []
            elif line.strip():
                assert current is not None and line.startswith("  "), line
                targets[current].append(line.strip())
        assert targets == expected, targets
        for name in ("pex", "uv"):
            assert not (root / f"locks/{name}.lock").exists(), name
    print("Python Luau guide consumer check passed: both lockfile targets discovered")
    check_core(binary, rules)


if __name__ == "__main__":
    main()
