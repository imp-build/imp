#!/usr/bin/env python3
"""Record and compare the cache / input-materialization workload of imp.

The cache subsystem (`crates/imp-store`) had no repeatable benchmark, so a
finished change could only be written down as "benchmark pending". This tool
runs a small, named set of builds and reads back the numbers that a cache or
materialization change moves.

Like `testdata/graph/BASELINE.md`, the load-bearing numbers are counts, not
times. A count does not change with the speed of the machine, so a change in
one means the work changed, not the host:

  - fresh sandboxes   how many actions ran (0 on a fully warm cache)
  - captures          files read and hashed into the CAS
  - materialize files  files copied out of the CAS into a sandbox or workspace
  - materialize dirs   `create_dir_all` calls on that copy path

`materialize dirs` is the only signal for the "one `create_dir_all` per
directory, not per file" work; the other three come from the goal summary and
from `IMP_TRACE_ARTIFACTS=1` output.

Protocol:
  - cold  a fresh `IMP_CACHE_DIR`, first run, so nothing is cached
  - warm  the same `IMP_CACHE_DIR`, the command run again until two runs in a
          row report 0 fresh sandboxes. `//crates/...` needs about five runs to
          get there, not two, so the graph baseline's "read the second result"
          rule does not hold for these counts.

Usage:
    ci/cache_baseline.py --check     compare with testdata/cache/BASELINE.md
    ci/cache_baseline.py --update    write the numbers into that file
    ci/cache_baseline.py --check --workload crates_build   only one workload
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE = REPO_ROOT / "testdata" / "cache" / "BASELINE.md"

# One selector for each path that matters to the cache work: the Rust crate
# graph is the warm-build materialization headline (toolchain trees copied
# through CAS input staging), and the CMake example exercises the compiler
# header scan that narrows each edge's input set.
WORKLOADS = {
    "crates_build": "//crates/...",
    "cmake_uses_cmake_lib": "//rules/c/cmake/example:uses_cmake_lib",
}

# The header a one-file edit touches for the CMake incremental probe.
CMAKE_TOUCH_HEADER = REPO_ROOT / "rules" / "c" / "cmake" / "example" / "hello.h"

MARK_BEGIN = "<!-- cache-baseline:metrics -->"
MARK_END = "<!-- /cache-baseline:metrics -->"

SANDBOXES_RE = re.compile(r"^sandboxes:\s*(\d+)\s*\((\d+) fresh, (\d+) cached\)", re.M)
CACHE_HIT_RE = re.compile(r"^cache:\s*hit\s*(\d+)%", re.M)
TIME_RE = re.compile(r"^time:\s*([\d.]+)s", re.M)
TOTALS_RE = re.compile(r"materialize totals: files=(\d+) dir_creates=(\d+)")


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


def run_build(selector: str, cache_dir: Path, cold: bool = False) -> tuple[str, str]:
    """Run `imp build <selector>` with artifact tracing on. Return stdout, stderr.

    A cold run fetches the toolchains, so it needs the network and can fail on a
    transient download error (a GitHub 504, say). Retry once; for a cold run
    empty the cache directory first, so the retry is still genuinely cold.
    """
    env = dict(os.environ)
    env["IMP_CACHE_DIR"] = str(cache_dir)
    env["IMP_TRACE_ARTIFACTS"] = "1"
    for attempt in (1, 2):
        if attempt == 2 and cold:
            for child in cache_dir.iterdir():
                shutil.rmtree(child) if child.is_dir() else child.unlink()
        result = subprocess.run(
            [str(imp_binary()), "build", selector],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=1800,
            env=env,
        )
        if result.returncode == 0:
            return result.stdout, result.stderr
        if attempt == 1:
            print(f"`imp build {selector}` failed (attempt 1); retrying once")
    sys.exit(
        f"`imp build {selector}` failed with code {result.returncode}:\n"
        + "\n".join(
            line
            for line in result.stderr.splitlines()
            if not line.startswith("[artifact-trace]")
        )[-4000:]
    )


def read_metrics(stdout: str, stderr: str) -> dict:
    """Pull the counts and the time out of one run's output."""
    sandboxes = SANDBOXES_RE.search(stdout)
    total, fresh, cached = (
        (int(sandboxes.group(1)), int(sandboxes.group(2)), int(sandboxes.group(3)))
        if sandboxes
        else (0, 0, 0)
    )
    hit = CACHE_HIT_RE.search(stdout)
    wall = TIME_RE.search(stdout)

    captures = sum(1 for line in stderr.splitlines() if "] capture " in line)
    # Nested `imp` invocations print their own totals line; sum them.
    mat_files = mat_dirs = 0
    for m in TOTALS_RE.finditer(stderr):
        mat_files += int(m.group(1))
        mat_dirs += int(m.group(2))

    return {
        "sandboxes": total,
        "fresh": fresh,
        "cached": cached,
        "cache_hit_pct": int(hit.group(1)) if hit else 0,
        "captures": captures,
        "materialize_files": mat_files,
        "materialize_dirs": mat_dirs,
        "time_s": float(wall.group(1)) if wall else 0.0,
    }


WARM_RUN_CAP = 10


def measure_workload(selector: str) -> dict[str, dict]:
    """Cold run, then warm runs until the cache reaches a fixed point.

    `//crates/...` does not settle on the second run — each warm run promotes
    one more action to cached and drops ~20 000 materializations, so it takes
    around five runs to reach 0 fresh. `testdata/graph/BASELINE.md`'s "read the
    second result" rule is therefore not safe for these counts. We run until
    two runs in a row report 0 fresh sandboxes, or `WARM_RUN_CAP` is hit, and
    record the last run plus how many it took.
    """
    with tempfile.TemporaryDirectory(prefix="imp-cache-baseline-") as cache_dir:
        cache = Path(cache_dir)
        cold = read_metrics(*run_build(selector, cache, cold=True))
        warm = cold
        settled = 0
        runs = 0
        while runs < WARM_RUN_CAP and settled < 2:
            warm = read_metrics(*run_build(selector, cache))
            runs += 1
            settled = settled + 1 if warm["fresh"] == 0 else 0
        warm["warm_runs"] = runs
    return {"cold": cold, "warm": warm}


def measure_cmake_header_touch(selector: str) -> int:
    """Warm the CMake build, touch one header, re-run. Return the fresh count."""
    with tempfile.TemporaryDirectory(prefix="imp-cache-baseline-") as cache_dir:
        cache = Path(cache_dir)
        run_build(selector, cache, cold=True)  # cold
        run_build(selector, cache)  # warm, seeds the cache
        original = CMAKE_TOUCH_HEADER.read_bytes()
        try:
            CMAKE_TOUCH_HEADER.write_bytes(original + b"\n// cache-baseline probe\n")
            after = read_metrics(*run_build(selector, cache))
        finally:
            CMAKE_TOUCH_HEADER.write_bytes(original)
    return after["fresh"]


# --- rendering --------------------------------------------------------------

COLUMNS = [
    ("sandboxes", "sandboxes"),
    ("fresh", "fresh"),
    ("cache_hit_pct", "hit %"),
    ("captures", "captures"),
    ("materialize_files", "mat files"),
    ("materialize_dirs", "mat dirs"),
    ("time_s", "time"),
]


def render_row(name: str, m: dict) -> str:
    cells = [name]
    for key, _ in COLUMNS:
        value = m[key]
        cells.append(f"{value:.2f}s" if key == "time_s" else str(value))
    return "| " + " | ".join(cells) + " |"


def render_table(title: str, rows: list[tuple[str, dict]]) -> str:
    header = "| workload | " + " | ".join(label for _, label in COLUMNS) + " |"
    sep = "| --- " * (len(COLUMNS) + 1) + "|"
    body = "\n".join(render_row(name, m) for name, m in rows)
    return f"### {title}\n\n{header}\n{sep}\n{body}\n"


def render_block(results: dict[str, dict], header_touch_fresh: int | None) -> str:
    warm = [(name, r["warm"]) for name, r in results.items()]
    cold = [(name, r["cold"]) for name, r in results.items()]
    runs_note = ", ".join(
        f"{name}: {r['warm'].get('warm_runs', '?')} runs" for name, r in results.items()
    )
    parts = [
        MARK_BEGIN,
        "",
        render_table("Warm cache (fixed point)", warm),
        f"Warm runs needed to reach 0 fresh — {runs_note}.\n",
        render_table("Cold cache (fresh IMP_CACHE_DIR, first run)", cold),
    ]
    if header_touch_fresh is not None:
        parts.append(
            "### CMake, one header edited\n\n"
            f"`{WORKLOADS['cmake_uses_cmake_lib']}` warm, then one header in "
            "`rules/c/cmake/example/` touched and rebuilt:\n\n"
            f"- fresh sandboxes after the edit: **{header_touch_fresh}**\n"
        )
    parts.append(MARK_END)
    return "\n".join(parts)


def splice(doc: str, block: str) -> str:
    if MARK_BEGIN in doc and MARK_END in doc:
        head = doc[: doc.index(MARK_BEGIN)]
        tail = doc[doc.index(MARK_END) + len(MARK_END) :]
        return head + block + tail
    sys.exit(f"{BASELINE} has no {MARK_BEGIN} .. {MARK_END} markers")


# --- main ------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="compare with the baseline")
    mode.add_argument("--update", action="store_true", help="write the baseline again")
    parser.add_argument(
        "--workload",
        action="append",
        choices=sorted(WORKLOADS),
        help="use only this workload; repeat the option for more",
    )
    args = parser.parse_args()

    names = args.workload or list(WORKLOADS)
    results = {name: measure_workload(WORKLOADS[name]) for name in names}
    header_touch_fresh = (
        measure_cmake_header_touch(WORKLOADS["cmake_uses_cmake_lib"])
        if "cmake_uses_cmake_lib" in names
        else None
    )

    block = render_block(results, header_touch_fresh)

    if args.update:
        doc = BASELINE.read_text()
        BASELINE.write_text(splice(doc, block))
        print(f"wrote {BASELINE.relative_to(REPO_ROOT)}")
        return 0

    # --check: the machine-independent columns must match the recorded block.
    doc = BASELINE.read_text()
    recorded = doc[doc.index(MARK_BEGIN) : doc.index(MARK_END) + len(MARK_END)]

    def strip_times(text: str) -> str:
        return re.sub(r"\|\s*[\d.]+s\s*\|", "| |", text)

    if strip_times(recorded).strip() == strip_times(block).strip():
        print("ok — cache workload numbers match the baseline")
        return 0
    print("CHANGED — cache workload numbers differ from the baseline\n")
    import difflib

    for line in difflib.unified_diff(
        strip_times(recorded).splitlines(),
        strip_times(block).splitlines(),
        "baseline",
        "measured",
        lineterm="",
    ):
        print(line)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
