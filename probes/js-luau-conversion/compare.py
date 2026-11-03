#!/usr/bin/env python3
"""Compare the outcomes of the old imp and imp-luau in one consumer checkout.

Usage: compare.py <repository> [--old imp] [--new imp-luau]
                  [--goal "<goal> [<flag>...]"]... [--root <selector>]...
                  [--no-cold] [--timeout <seconds>] [--ignore <glob>]...

Both binaries run the same goals on the same sources: the Luau files are
beside the JavaScript files. For each binary the script runs every goal with
an empty cache root (cold), then again with the same cache root (warm), and
then deletes that cache root. With --no-cold, each binary runs every goal one
time with its usual cache root. A run that takes longer than --timeout
seconds (default 1800) stops and gets exit code 124.

The script compares exit codes, the targets and goals of each root, the
status of each unit in the test, fmt, and lint reports, and the digests of the
files that each goal writes into the checkout. It does not compare action or
cache keys, because they are different between the binaries by design.

Use --ignore for written files that are not deterministic, for example a debug
binary that contains sandbox paths. The glob applies to the path relative to
the checkout, and `*` also matches `/`. When both binaries write a matching
file with different digests, the report shows it as ignored and does not count
it. A matching file that only one binary writes is still a difference.

The evidence goes to <repository>/.imp-compare/, which git ignores: one log
for each run, summary.tsv in the format of ci/run_check.py, and report.md.
The last output line is a one-line summary. The script exits with 0 when it
finds no differences and with 1 when it finds differences.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

OUT = ".imp-compare"
DEFAULT_GOALS = ["targets", "fmt --check", "lint", "test", "build"]
# Status values of the reports that rules/workflows/report.luau renders.
STATUSES = {"PASS", "FAIL", "UNCHANGED", "CHANGED", "FAILED", "CLEAN", "FIXED"}
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
REPORT_LINE = re.compile(r"^(?P<key>\S.*?) {2,}(?P<status>[A-Z]+)$")
TARGET_LINE = re.compile(r"^(?P<address>//\S+) \((?P<kind>[^)]*)\)$")
GOAL_LINE = re.compile(r"^ {2}(?P<goal>\S+)$")


def plain_lines(text):
    """Return the lines of `text` without ANSI codes and overwritten progress."""
    return [ANSI.sub("", line.split("\r")[-1]) for line in text.splitlines()]


def parse_targets(text):
    """Parse `imp targets` output into {address: (kind, set of goals)}."""
    targets = {}
    current = None
    for line in plain_lines(text):
        target = TARGET_LINE.match(line)
        goal = GOAL_LINE.match(line)
        if target:
            current = target["address"]
            targets[current] = (target["kind"], set())
        elif goal and current is not None:
            targets[current][1].add(goal["goal"])
        else:
            current = None
    return targets


def parse_report(text):
    """Parse a status report into {key: status}.

    The report has one aligned line for each unit, then an output block for
    some units. An output block starts with a `<key>:` line, so parsing stops
    at the first such line.
    """
    units = {}
    for line in plain_lines(text):
        if line.endswith(":") and line[:-1] in units:
            break
        match = REPORT_LINE.match(line)
        if match and match["status"] in STATUSES:
            units[match["key"]] = match["status"]
    return units


def diff_targets(old, new, labels):
    """Return the root and goal differences, and the kind changes apart."""
    differences = []
    kinds = []
    for address in sorted(old.keys() | new.keys()):
        if address not in new:
            differences.append(f"{address}: only with {labels[0]}")
        elif address not in old:
            differences.append(f"{address}: only with {labels[1]}")
        else:
            (old_kind, old_goals), (new_kind, new_goals) = old[address], new[address]
            if old_goals != new_goals:
                differences.append(
                    f"{address}: goals {sorted(old_goals)} with {labels[0]}, "
                    f"{sorted(new_goals)} with {labels[1]}"
                )
            if old_kind != new_kind:
                kinds.append(f"{address}: {old_kind} -> {new_kind}")
    return differences, kinds


def diff_maps(old, new, labels, describe):
    """Return a line for each key that is missing or different in `new`."""
    differences = []
    for key in sorted(old.keys() | new.keys()):
        if key not in new:
            differences.append(f"{key}: only with {labels[0]} ({describe(old[key])})")
        elif key not in old:
            differences.append(f"{key}: only with {labels[1]} ({describe(new[key])})")
        elif old[key] != new[key]:
            differences.append(
                f"{key}: {describe(old[key])} with {labels[0]}, "
                f"{describe(new[key])} with {labels[1]}"
            )
    return differences


def split_ignored(old, new, globs):
    """Remove from `old` and `new` the paths that are in both maps and that
    match a glob in `globs`. Return the two remaining maps and
    {path: (old digest, new digest)} for the removed paths with different
    digests."""
    shared = {
        path
        for path in old.keys() & new.keys()
        if any(fnmatch.fnmatchcase(path, glob) for glob in globs)
    }
    moved = {
        path: (old[path], new[path])
        for path in sorted(shared)
        if old[path] != new[path]
    }
    old = {path: sha for path, sha in old.items() if path not in shared}
    new = {path: sha for path, sha in new.items() if path not in shared}
    return old, new, moved


def snapshot(root):
    """Return {relative path: file identity} for the files of the checkout.

    A write changes the ctime even when the writer keeps the mtime, and a
    rename or a new link changes the inode.
    """
    files = {}
    for directory, names, filenames in os.walk(root):
        names[:] = [name for name in names if name not in (".git", OUT)]
        for filename in filenames:
            path = Path(directory, filename)
            try:
                status = path.lstat()
            except FileNotFoundError:
                continue
            files[path.relative_to(root).as_posix()] = (
                status.st_ino,
                status.st_size,
                status.st_mtime_ns,
                status.st_ctime_ns,
            )
    return files


def digest(path):
    if path.is_symlink():
        return "symlink:" + os.readlink(path)
    sha = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def written_files(root, before):
    """Return {path: sha256} for the files that are new or changed since
    `before`. A file that a run writes again with the same content counts."""
    after = snapshot(root)
    return {
        path: digest(root / path)
        for path, identity in sorted(after.items())
        if before.get(path) != identity
    }


def run(command, cwd, env, log_path, timeout):
    """Run `command` and keep its log. Return (exit code, seconds, output).

    A run that takes longer than `timeout` seconds gets exit code 124, as with
    timeout(1). The command runs in its own session, so that the script can
    stop the command and the processes that it started.
    """
    started = time.monotonic()
    note = b""
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        code, output = 127, f"cannot start command: {error}\n".encode()
    else:
        try:
            output, _ = process.communicate(timeout=timeout)
            code = process.returncode
        except subprocess.TimeoutExpired:
            output = stop(process)
            code = 124
            note = f"timed out after {timeout}s\n".encode()
    seconds = time.monotonic() - started
    with open(log_path, "wb") as log:
        log.write(f"$ {shlex.join(command)}\n".encode())
        log.write(output)
        log.write(note)
        log.write(f"exit: {code}\n".encode())
    return code, seconds, output.decode(errors="replace")


def stop(process):
    """Stop the session of `process` and return the output that it wrote."""
    for sig, grace in ((signal.SIGTERM, 10), (signal.SIGKILL, None)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        try:
            output, _ = process.communicate(timeout=grace)
            return output
        except subprocess.TimeoutExpired:
            continue
    return b""


def goal_name(goal):
    return shlex.split(goal)[0]


def run_binary(repo, out, binary, label, goals, roots, phases, timeout):
    """Run every goal in every phase. Return {phase: {goal: result}}."""
    results = {}
    cache = None
    env = os.environ.copy()
    if "cold" in phases:
        cache = tempfile.mkdtemp(prefix=f"imp-compare-{label}-")
        # The imp-luau wrapper sets IMP_CACHE_DIR from IMP_LUAU_CACHE_DIR.
        env["IMP_CACHE_DIR"] = env["IMP_LUAU_CACHE_DIR"] = cache
    try:
        for phase in phases:
            results[phase] = {}
            for goal in goals:
                name = f"{label}-{phase}-{goal_name(goal)}"
                command = [binary, *shlex.split(goal), *roots]
                before = snapshot(repo)
                code, seconds, output = run(
                    command, repo, env, out / f"{name}.log", timeout
                )
                results[phase][goal] = {
                    "name": name,
                    "command": shlex.join(command),
                    "exit": code,
                    "seconds": seconds,
                    "output": output,
                    "written": written_files(repo, before),
                }
                print(f"{name}: exit {code} in {seconds:.1f}s", flush=True)
    finally:
        if cache is not None:
            shutil.rmtree(cache, ignore_errors=True)
    return results


def compare(results, labels, goals, phases, ignore=()):
    """Return {category: [difference]}, the kind changes of the roots, and the
    ignored digest differences."""
    old, new = (results[label] for label in labels)
    differences = {"exit": [], "targets": [], "units": [], "outputs": []}
    kinds = []
    ignored = []
    for phase in phases:
        for goal in goals:
            if old[phase][goal]["exit"] != new[phase][goal]["exit"]:
                differences["exit"].append(
                    f"{phase} `{goal}`: exit {old[phase][goal]['exit']} with "
                    f"{labels[0]}, {new[phase][goal]['exit']} with {labels[1]}"
                )
    # The cold run (or the only run) holds the outcomes. The warm run must
    # agree with it, which the exit codes show.
    first = phases[0]
    for goal in goals:
        a, b = old[first][goal], new[first][goal]
        name = goal_name(goal)
        if name == "targets":
            found, kinds = diff_targets(
                parse_targets(a["output"]), parse_targets(b["output"]), labels
            )
            differences["targets"] += found
        else:
            differences["units"] += [
                f"`{goal}` {line}"
                for line in diff_maps(
                    parse_report(a["output"]),
                    parse_report(b["output"]),
                    labels,
                    str,
                )
            ]
        old_written, new_written, moved = split_ignored(
            a["written"], b["written"], ignore
        )
        differences["outputs"] += [
            f"`{goal}` {line}"
            for line in diff_maps(
                old_written, new_written, labels, lambda sha: sha[:12]
            )
        ]
        ignored += [
            f"`{goal}` {path}: {old_sha[:12]} with {labels[0]}, "
            f"{new_sha[:12]} with {labels[1]}"
            for path, (old_sha, new_sha) in moved.items()
        ]
    return differences, kinds, ignored


def summary_line(repo, differences, ignored, results, labels, phases):
    total = sum(len(found) for found in differences.values())
    counts = ", ".join(f"{name} {len(found)}" for name, found in differences.items())
    if ignored:
        counts += f", ignored {len(ignored)}"
    times = " · ".join(
        f"{phase} "
        + " / ".join(
            f"{label} "
            f"{sum(result['seconds'] for result in results[label][phase].values()):.1f}s"
            for label in labels
        )
        for phase in phases
    )
    return f"{repo.name}: {total} difference(s) ({counts}) · {times}"


def write_report(
    out, line, differences, kinds, ignored, ignore, results, labels, phases
):
    with open(out / "summary.tsv", "w") as rows:
        rows.write("name\texit\tseconds\tcommand\n")
        for label in labels:
            for phase in phases:
                for result in results[label][phase].values():
                    rows.write(
                        f"{result['name']}\t{result['exit']}\t"
                        f"{result['seconds']:.1f}\t{result['command']}\n"
                    )
    lines = [line, "", "## Runs", "", "| run | exit | seconds | command |"]
    lines.append("| --- | --- | --- | --- |")
    for label in labels:
        for phase in phases:
            for result in results[label][phase].values():
                lines.append(
                    f"| {result['name']} | {result['exit']} | "
                    f"{result['seconds']:.1f} | `{result['command']}` |"
                )
    titles = {
        "exit": "Exit codes",
        "targets": "Targets and goals",
        "units": "Test, fmt, and lint units",
        "outputs": "Written files",
    }
    for category, found in differences.items():
        lines += ["", f"## {titles[category]}", ""]
        lines += [f"- {item}" for item in found] or ["No differences."]
    lines += ["", "## Root kinds (not counted)", ""]
    lines += [f"- {item}" for item in kinds] or ["No changes."]
    if ignore:
        lines += ["", "## Ignored written files (not counted)", ""]
        lines.append("Globs: " + ", ".join(f"`{glob}`" for glob in ignore))
        lines.append("")
        lines += [f"- {item}" for item in ignored] or ["No differences."]
    (out / "report.md").write_text("\n".join(lines) + "\n")


def prepare_out(repo):
    """Empty the evidence directory and make git ignore it."""
    out = repo / OUT
    marker = out / ".gitignore"
    if out.exists() and not marker.exists():
        sys.exit(f"{out} exists and was not made by this script")
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    marker.write_text("*\n")
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("repository", type=Path)
    parser.add_argument("--old", default="imp")
    parser.add_argument("--new", default="imp-luau")
    parser.add_argument("--goal", action="append", dest="goals")
    parser.add_argument("--root", action="append", dest="roots")
    parser.add_argument("--no-cold", action="store_true")
    parser.add_argument(
        "--ignore",
        action="append",
        default=[],
        metavar="GLOB",
        help="do not count digest differences of written files that match",
    )
    parser.add_argument(
        "--timeout", type=float, default=1800, help="seconds for each run"
    )
    args = parser.parse_args(argv)
    repo = args.repository.resolve()
    goals = args.goals or DEFAULT_GOALS
    roots = args.roots or ["//..."]
    phases = ["default"] if args.no_cold else ["cold", "warm"]
    labels = [Path(args.old).name, Path(args.new).name]
    if labels[0] == labels[1]:
        labels = ["old", "new"]
    out = prepare_out(repo)
    results = {
        label: run_binary(repo, out, binary, label, goals, roots, phases, args.timeout)
        for label, binary in zip(labels, [args.old, args.new])
    }
    differences, kinds, ignored = compare(results, labels, goals, phases, args.ignore)
    line = summary_line(repo, differences, ignored, results, labels, phases)
    write_report(
        out, line, differences, kinds, ignored, args.ignore, results, labels, phases
    )
    print(f"report: {out / 'report.md'}")
    print(line)
    return 1 if any(differences.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
