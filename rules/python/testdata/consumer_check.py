"""Check target discovery for the documented Python Luau lockfile example."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


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


if __name__ == "__main__":
    main()
