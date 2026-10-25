#!/usr/bin/env python3
"""Check Luau BUILD coverage and the live repository integration contract."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

# These modules have no supported Luau target to port. Keep the exclusions
# narrow so a new JavaScript-only BUILD file fails this check.
EXCLUSIONS = {
    "rules/BUILD.js": "JavaScript source formatting inventory; Luau formatting is a separate post-cutover task.",
    "rules/imp/test/BUILD.js": "QuickJS test-harness implementation; Luau tests use core.test_root.",
    "rules/workflows/build/BUILD.js": "QuickJS workflow tests; Luau workflow tests are declared by rules/workflows/BUILD.luau.",
    "crates/imp/src/BUILD.js": "Embedded JavaScript source formatting; removed with the QuickJS implementation.",
    "examples/proposed-rules/BUILD.js": "Illustrative proposal with a provisioned local toolchain, not a supported consumer.",
}


def inventory(root):
    builds = []
    for directory, dirs, files in os.walk(root):
        dirs[:] = [
            d
            for d in dirs
            if d
            not in (".git", ".imp", "target", "dist", "node_modules", "__pycache__")
        ]
        if "BUILD.js" in files:
            builds.append((Path(directory) / "BUILD.js").relative_to(root).as_posix())
    missing = [
        p
        for p in builds
        if not (root / p).with_suffix(".luau").is_file() and p not in EXCLUSIONS
    ]
    assert not missing, (
        f"BUILD files without Luau implementations or exclusions: {missing}"
    )
    for path in EXCLUSIONS:
        assert path in builds, f"stale exclusion: {path}"
    return builds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    root = Path.cwd()
    builds = inventory(root)
    env = {**os.environ, "IMP_RUNTIME": "luau"}

    def run(*arguments):
        result = subprocess.run(
            [str(binary), *arguments],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "failed:" not in result.stdout and "execute goal" not in result.stderr, (
            result.stdout + result.stderr
        )
        return result.stdout

    text = run("targets", "//...")
    targets = {}
    current = None
    for line in text.splitlines():
        if line.startswith("//"):
            current = line.split(" ", 1)[0]
            targets[current] = set()
        elif line.startswith("  ") and current:
            targets[current].add(line.strip().split(":", 1)[0])
    for crate in (root / "crates").iterdir():
        if (crate / "Cargo.toml").is_file():
            name = "imp" if crate.name == "imp" else crate.name.replace("-", "_")
            address = f"//crates/{crate.name}:{name}"
            assert {"fmt", "lint", "test"} <= targets.get(address, set()), address
    expected = {
        "//ci:docs_workflow": {"generate"},
        "//docs:api_reference": {"build"},
        "//docs:site": {"build", "package"},
        "//docs:quality": {"lint"},
        "//docs:quality_tests": {"test"},
        "//docs:site_serve": {"run"},
        "//rules/treesitter:roundtrip": {"test"},
        "//rules/odin/example/split:lib_tests": {"test"},
    }
    for address, workflows in expected.items():
        assert workflows <= targets.get(address, set()), (address, targets.get(address))
    # Regression: an Odin library has no runnable child. Main packages do.
    assert "run" not in targets["//rules/odin/example/split:lib"]
    assert not any(
        p.startswith("//rules/odin/example/split:lib#") and "run" in w
        for p, w in targets.items()
    )
    assert any(
        p.startswith("//rules/odin/example:hello") and "run" in w
        for p, w in targets.items()
    )
    effective = json.loads(run("config", "schema", "--effective"))["effective"]
    for namespace in ("c", "rust", "odin"):
        assert effective[namespace]["build_generate"] is True, namespace
    result = run("goal", "generate-build", "--check")
    assert re.search(r"generate-build: \d+ file\(s\) checked, 0 out of date", result), (
        result
    )
    for path, reason in sorted(EXCLUSIONS.items()):
        print(f"excluded {path}: {reason}")
    print(
        f"Luau workspace check passed: {len(builds)} BUILD files, {len(EXCLUSIONS)} exclusions, {len(targets)} targets; C, Rust, and Odin generation enabled."
    )
    print(result.strip())


if __name__ == "__main__":
    main()
