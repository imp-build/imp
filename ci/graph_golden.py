#!/usr/bin/env python3
"""Record and compare the structure of the imp build graph.

The graph work item changes when nodes are found and in which order they
run. Node numbers in `imp graph` output follow the order of allocation, so
they move when that order changes, even if the graph keeps the same shape.
A golden file that holds those numbers gives a large difference for each
change. You then cannot see a true change in the graph.

This tool removes the numbers. It gives each node a fingerprint that comes
from the content of the node: its label, its shape, and the fingerprints of
the nodes below it. Two graphs with the same structure give the same
golden, and the order of allocation has no effect.

The golden also holds a count for each fingerprint. The count is the number
of different node numbers that have that fingerprint. Without the count, a
node that is accidentally made two times looks the same as one node,
because both copies have equal content. Dedup is what phase 3 changes, thus
the count must stay in the golden.

Usage:
    ci/graph_golden.py --check     compare the graph with the golden files
    ci/graph_golden.py --update    write the golden files again
    ci/graph_golden.py --check --target python_scripts    only one target
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GOLDEN_DIR = REPO_ROOT / "testdata" / "graph"

# One target for each way that expand() gets its inputs. The first two
# expansions read only sources and configuration, thus the graph can find
# their children without running an action. The last two read the output of
# an action, thus an action must run before their children are known.
TARGETS = {
    "python_scripts": "//rules/python/example:scripts",
    "odin_hello": "//rules/odin/example:hello",
    "rust_scheduler": "//crates/imp-scheduler:imp_scheduler",
    "cmake_uses_cmake_lib": "//rules/c/cmake/example:uses_cmake_lib",
}

# `  n12["label"]` or `  n12[["label"]]`. A double bracket marks a root.
NODE_RE = re.compile(r'^\s*n(\d+)\[(\[?)"(.*?)"\]?\]\s*$')
# `  n1 -->|label| n2` or `  n1 --> n2`.
EDGE_RE = re.compile(r"^\s*n(\d+)\s*-->\s*(?:\|(.*?)\|\s*)?n(\d+)\s*$")
# Lines that carry no structure.
SKIP_RE = re.compile(r"^\s*(%%.*|flowchart\s+\w+|graph\s+\w+|)$")


def imp_binary() -> Path:
    """Return the imp binary to run."""
    override = os.environ.get("IMP_BIN")
    if override:
        return Path(override)
    for name in ("release", "debug"):
        candidate = REPO_ROOT / "target" / name / "imp"
        if candidate.exists():
            return candidate
    sys.exit("no imp binary found; build one or set IMP_BIN")


def render(selector: str, show_plumbing: bool) -> str:
    """Run `imp graph` and return the diagram text."""
    argv = [str(imp_binary()), "graph", selector, "--expand-children"]
    if show_plumbing:
        argv.append("--show-plumbing")
    result = subprocess.run(
        argv, cwd=REPO_ROOT, capture_output=True, text=True, timeout=1800
    )
    if result.returncode != 0:
        sys.exit(
            f"`imp graph {selector}` failed with code {result.returncode}:\n"
            f"{result.stderr}"
        )
    return result.stdout


def parse(text: str) -> tuple[dict[int, tuple[str, str]], list[tuple[int, str, int]]]:
    """Read the diagram into nodes and edges.

    Returns the nodes as `{id: (shape, label)}` and the edges as a list of
    `(source_id, edge_label, target_id)`. A line that the tool cannot read
    stops the run, because a silent skip can hide part of the graph.
    """
    nodes: dict[int, tuple[str, str]] = {}
    edges: list[tuple[int, str, int]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if SKIP_RE.match(line):
            continue
        node = NODE_RE.match(line)
        if node:
            node_id, double, label = node.groups()
            nodes[int(node_id)] = ("root" if double else "node", label)
            continue
        edge = EDGE_RE.match(line)
        if edge:
            source, label, target = edge.groups()
            edges.append((int(source), label or "", int(target)))
            continue
        sys.exit(f"line {number} of the diagram is not known to this tool:\n  {line}")
    return nodes, edges


def fingerprints(
    nodes: dict[int, tuple[str, str]], edges: list[tuple[int, str, int]]
) -> dict[int, str]:
    """Give each node a fingerprint that comes from its content.

    The fingerprint of a node is a hash of its shape, its label, and the
    edge labels and fingerprints of the nodes below it. The result does not
    change when the node numbers change.
    """
    below: dict[int, list[tuple[str, int]]] = {node_id: [] for node_id in nodes}
    for source, label, target in edges:
        if source not in nodes or target not in nodes:
            sys.exit(f"edge n{source} -> n{target} points to a node that is not there")
        below[source].append((label, target))

    cache: dict[int, str] = {}
    # `busy` holds the nodes of the current path. The graph must be acyclic
    # after expansion; a cycle would make the fingerprint have no end.
    busy: set[int] = set()

    def compute(node_id: int) -> str:
        if node_id in cache:
            return cache[node_id]
        if node_id in busy:
            sys.exit(f"the graph has a cycle at node n{node_id}")
        busy.add(node_id)
        shape, label = nodes[node_id]
        parts = [shape, label]
        for edge_label, target in sorted(
            below[node_id], key=lambda item: (item[0], compute(item[1]))
        ):
            parts.append(edge_label)
            parts.append(compute(target))
        busy.discard(node_id)
        digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:12]
        cache[node_id] = digest
        return digest

    for node_id in nodes:
        compute(node_id)
    return cache


def canonicalize(text: str) -> str:
    """Turn a diagram into a golden that holds only its structure."""
    nodes, edges = parse(text)
    marks = fingerprints(nodes, edges)

    # How many separate nodes carry each fingerprint. A rise in a count
    # means the graph made a node that it made only one time before.
    counts: dict[str, int] = {}
    for node_id in nodes:
        counts[marks[node_id]] = counts.get(marks[node_id], 0) + 1

    node_lines = set()
    for node_id, (shape, label) in nodes.items():
        mark = marks[node_id]
        node_lines.add(f"{mark}  x{counts[mark]}  {shape:4}  {label}")

    edge_lines = set()
    for source, label, target in edges:
        edge_lines.add(f"{marks[source]}  -{label}->  {marks[target]}")

    out = [
        "# Structure of the imp build graph. Node numbers are removed.",
        "# Each line starts with a fingerprint of the content of the node.",
        "# `xN` is the number of separate nodes that have that fingerprint.",
        "# Write this file again with: ci/graph_golden.py --update",
        "",
        f"nodes {len(nodes)}  unique {len(counts)}  edges {len(edges)}",
        "",
        "[nodes]",
        *sorted(node_lines),
        "",
        "[edges]",
        *sorted(edge_lines),
        "",
    ]
    return "\n".join(out)


def golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.golden"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="compare with the goldens")
    mode.add_argument("--update", action="store_true", help="write the goldens again")
    parser.add_argument(
        "--target",
        action="append",
        choices=sorted(TARGETS),
        help="use only this target; repeat the option for more",
    )
    parser.add_argument(
        "--no-plumbing",
        action="store_true",
        help="leave out tool and semantic leaves",
    )
    args = parser.parse_args()

    names = args.target or sorted(TARGETS)
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    failures = 0

    for name in names:
        selector = TARGETS[name]
        actual = canonicalize(render(selector, not args.no_plumbing))
        path = golden_path(name)

        if args.update:
            had = path.read_text() if path.exists() else None
            path.write_text(actual)
            state = "same" if had == actual else ("new" if had is None else "changed")
            print(f"{state:8} {path.relative_to(REPO_ROOT)}  ({selector})")
            continue

        if not path.exists():
            print(f"MISSING  {path.relative_to(REPO_ROOT)} — run --update")
            failures += 1
            continue
        expected = path.read_text()
        if expected == actual:
            print(f"ok       {name}  ({selector})")
            continue

        failures += 1
        print(f"CHANGED  {name}  ({selector})")
        import difflib

        diff = difflib.unified_diff(
            expected.splitlines(),
            actual.splitlines(),
            fromfile=f"{name}.golden",
            tofile="actual",
            lineterm="",
        )
        for line in list(diff)[:60]:
            print(f"    {line}")

    if failures:
        print(f"\n{failures} of {len(names)} targets changed shape.")
        print("If the change is wanted, run: ci/graph_golden.py --update")
        return 1
    if args.check:
        print(f"\nall {len(names)} targets match their golden.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
