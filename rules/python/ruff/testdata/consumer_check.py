"""Check Luau Ruff workflows with real tools in an isolated workspace."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    binary = parser.parse_args().imp.resolve()
    rules = Path(__file__).resolve().parents[3]
    env = {**os.environ, "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-ruff-consumer-") as directory:
        root = Path(directory)
        workspace = '''require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
return {}
'''
        (root / "imp.workspace.luau").write_text(workspace)
        (root / "pyproject.toml").write_text('[project]\nname="ruff-consumer"\nversion="0.0.0"\n')
        (root / "ruff.toml").write_text('line-length = 100\n')
        target = '''local python = require("@imp/rules/python")
return { app = python.python_app({ sources = { "src/**/*.py" } }),
    tests = python.python_test({ sources = { "tests/*.py" } }),
    empty = python.python_app({ sources = { "absent.py" } }) }
'''
        for base in [root, root / "nested space"]:
            base.mkdir(exist_ok=True)
            (base / "BUILD.luau").write_text(target)
            if base != root:
                (base / "pyproject.toml").write_text('[project]\nname="nested-consumer"\nversion="0.0.0"\n')
            (base / "src" / "pkg").mkdir(parents=True)
            (base / "tests").mkdir()
            (base / "other").mkdir()
            (base / "other" / "ruff.toml").write_text('invalid = true\n')
            (base / "src" / "pkg" / "two words.py").write_text('value={"a":1}\n')
            (base / "tests" / "test_mod.py").write_text('value={"a":1}\n')
            (base / "unselected.py").write_text('import os\nvalue={"a":1}\n')
        unselected = {p: p.read_bytes() for p in root.rglob("unselected.py")}

        def run(*arguments, success=True, expected=None):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert (result.returncode == 0) == success, result.returncode
            if expected:
                assert expected in result.stdout + result.stderr
            return result

        run("@ruff", "--version", expected="0.16.7")
        for package in ["", "nested space"]:
            base = root / package
            source = base / "src" / "pkg" / "two words.py"
            address = f"//{package}:app"
            original = source.read_bytes()
            run("fmt", "--check", address, success=False)
            assert source.read_bytes() == original
            run("fmt", address)
            assert source.read_bytes() != original
            run("fmt", "--check", address)
            run("lint", address)
            config = base / "src" / "pkg" / ".ruff.toml"
            config.write_text('extend = "../../ruff.toml"\n[lint]\nselect = ["F401"]\n')
            if package:
                config.write_text('extend = "../../../ruff.toml"\n[lint]\nselect = ["F401"]\n')
            source.write_text('import os\n')
            original = source.read_bytes()
            run("lint", address, success=False, expected="F401")
            assert source.read_bytes() == original
            run("lint", "--fix", address)
            assert "import os" not in source.read_text()
            run("lint", address)
            # A config-only change must invalidate the clean result.
            source.write_text('import os\n')
            config.write_text('[lint]\nignore = ["F401"]\n')
            run("lint", address)
            config.write_text('[lint]\nselect = ["F401"]\n')
            run("lint", address, success=False, expected="F401")
            config.write_text('[lint]\nselect = ["F401", "F821"]\n')
            source.write_text('import os\nprint(undefined_name)\n')
            run("lint", "--fix", address, success=False, expected="F821")
            assert "import os" not in source.read_text()
            assert "undefined_name" in source.read_text()
            run("fmt", f"//{package}:tests")
            run("fmt", "--check", f"//{package}:tests")
            run("lint", f"//{package}:tests")
            run("fmt", f"//{package}:empty")
            run("lint", f"//{package}:empty")
            source.write_text('def =\n')
            original = source.read_bytes()
            run("fmt", address, success=False)
            assert source.read_bytes() == original
            run("lint", address, success=False)
        for path, original in unselected.items():
            assert path.read_bytes() == original
        # Check each facet without importing the other facet.
        for kind in ["fmt", "lint"]:
            (root / "imp.workspace.luau").write_text(f'require("@imp/rules/python/ruff/{kind}")\nreturn {{}}\n')
            run(kind, "//:empty")
        # Use the capture destination as the source to check same-path installs.
        local = '''local core = require("@imp/core")
local ruff = require("@imp/rules/python/ruff_toolchain")
local source = core.task({ inputs = { sh = core.native_tool("sh"), mkdir = core.native_tool("mkdir"), chmod = core.native_tool("chmod") },
    outputs = { dir = core.output.artifact() }, run = function(exec)
        local result = exec.action({ argv = { "sh", "-c", [=[mkdir -p captured-ruff && printf '%s\\n' '#!/bin/sh' 'echo local-one' 'echo "$0"' > captured-ruff/ruff && chmod +x captured-ruff/ruff]=] },
            outputs = { dir = core.output.directory("captured-ruff") } })
        return { dir = result.outputs.dir }
    end })
ruff.install_ruff_toolchain("local", core.path(source.outputs.dir), { default = true })
return {}
'''
        (root / "imp.workspace.luau").write_text(local)
        first = run("@ruff", "--version", expected="local-one")
        (root / "imp.workspace.luau").write_text(local.replace("local-one", "local-two").replace("core.path(source.outputs.dir)", "source.outputs.dir"))
        second = run("@ruff", "--version", expected="local-two")
        first_path = next(line for line in first.stdout.splitlines() if "ruff-local-toolchains" in line)
        second_path = next(line for line in second.stdout.splitlines() if "ruff-local-toolchains" in line)
        assert first_path != second_path
    print("Luau Ruff consumer check passed")


if __name__ == "__main__":
    main()
