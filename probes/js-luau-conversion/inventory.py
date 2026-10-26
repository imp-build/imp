#!/usr/bin/env python3
"""Audit the removal of JavaScript authoring and the retained application inputs."""

from __future__ import annotations

import collections
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name("removal-manifest.json")


def checked_path(root, path):
    """Reject manifest paths that can leave the repository."""
    if not isinstance(path, str) or not path:
        raise ValueError(f"invalid manifest path: {path!r}")
    relative = PurePosixPath(path)
    if relative.is_absolute() or ".." in relative.parts or "\\" in path:
        raise ValueError(f"invalid manifest path: {path!r}")
    candidate = root / path
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"manifest path leaves the repository: {path}")
    return candidate


def audit(root, manifest, tracked):
    """Return audit errors; pending Git deletions need no source file reads."""
    errors = []
    if manifest.get("version") != 1:
        return ["unsupported removal manifest version"]
    rows = manifest["removed_authoring"]
    retained = manifest["retained_inputs"]
    sources = [row["source"] for row in rows]
    for name, paths in (("removed source", sources), ("retained input", retained)):
        for path, count in collections.Counter(paths).items():
            if count > 1:
                errors.append(f"duplicate {name}: {path}")
    for path in sorted(set(sources) & set(retained)):
        errors.append(f"source is both removed and retained: {path}")
    for path in retained:
        if not checked_path(root, path).is_file():
            errors.append(f"missing retained input: {path}")
        if path not in tracked:
            errors.append(f"retained input is not tracked: {path}")
    for row in rows:
        source = row["source"]
        if checked_path(root, source).exists():
            errors.append(f"obsolete authoring file remains: {source}")
        replacements = row.get("replacements", [])
        exclusion = row.get("exclusion")
        if bool(replacements) == bool(exclusion):
            errors.append(f"source needs replacements or an exclusion: {source}")
        evidence = row.get("evidence", [])
        if not evidence:
            errors.append(f"missing removal evidence: {source}")
        for path in replacements + evidence:
            if not checked_path(root, path).is_file():
                errors.append(f"missing replacement or evidence for {source}: {path}")
        gap = row.get("coverage_gap")
        if gap is not None and (
            not gap.get("description")
            or not gap.get("follow_up", "").startswith("imp:")
        ):
            errors.append(f"coverage gap needs a description and follow-up: {source}")
    # Git still lists deleted files before they are staged. Every tracked
    # source needs a manifest record, including a file absent from disk.
    for path in sorted(tracked):
        if path.endswith((".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")):
            if path not in retained and path not in sources:
                errors.append(f"unexpected tracked JavaScript/TypeScript file: {path}")
    return errors


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, stdout=subprocess.PIPE
    )
    tracked = {path.decode("utf-8") for path in result.stdout.split(b"\0") if path}
    errors = audit(ROOT, manifest, tracked)
    if errors:
        for error in errors:
            print(f"inventory failed: {error}", file=sys.stderr)
        return 1
    print("JavaScript authoring cutover audit passed")
    print(f"Removed authoring files: {len(manifest['removed_authoring'])}")
    print("Retained application inputs:")
    for path in manifest["retained_inputs"]:
        print(f"- {path}")
    print("Coverage gaps (not equivalent coverage or behavior exclusions):")
    for row in manifest["removed_authoring"]:
        if gap := row.get("coverage_gap"):
            print(
                f"- {row['source']}: {gap['description']} Follow-up: {gap['follow_up']}"
            )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"inventory failed: {error}", file=sys.stderr)
        sys.exit(1)
