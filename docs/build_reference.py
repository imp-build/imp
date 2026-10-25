#!/usr/bin/env python3
"""Run the graph-built Luau extractor and render its deterministic output."""

import argparse
import json
import subprocess
from pathlib import Path

from luau_api_extract import render

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--extractor", required=True)
p.add_argument("--grammar", required=True)
p.add_argument("--schemas", required=True)
p.add_argument("--output", type=Path, required=True)
a = p.parse_args()
paths = sorted(
    str(path)
    for path in Path("rules").rglob("*.luau")
    if path.name != "BUILD.luau"
    and not path.name.endswith(".test.luau")
    and not any(part in ("testdata", "example", "target") for part in path.parts)
    and path.name != "no_handler_check.luau"
)
paths.append("docs/core_api.luau")
manifest = Path("reference-sources.json")
manifest.write_text(json.dumps(paths))
with Path("reference-syntax.json").open("w") as stream:
    subprocess.run([a.extractor, a.grammar, str(manifest)], stdout=stream, check=True)
guides = {str(path): path.read_text() for path in sorted(Path("rules").rglob("DOC.md"))}
a.output.mkdir(parents=True, exist_ok=True)
render(
    json.loads(Path("reference-syntax.json").read_text()),
    json.loads(a.schemas),
    a.output,
    guides,
)
