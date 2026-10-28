#!/usr/bin/env python3
"""Run one CI check and keep its command, exit code, and output as evidence.

Usage: ci/run_check.py <name> -- <command> [<argument>...]

The output goes to the step log and to ci-evidence/<name>.log. The script
appends one row to ci-evidence/summary.tsv and exits with the exit code of the
command. A workflow uploads ci-evidence/ as an artifact.
"""

import shlex
import subprocess
import sys
import time
from pathlib import Path

EVIDENCE = Path("ci-evidence")


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        sys.exit(__doc__)
    name, command = sys.argv[1], sys.argv[3:]
    EVIDENCE.mkdir(exist_ok=True)
    started = time.monotonic()
    with open(EVIDENCE / f"{name}.log", "wb") as log:
        log.write(f"$ {shlex.join(command)}\n".encode())
        log.flush()
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        assert process.stdout is not None
        for chunk in process.stdout:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            log.write(chunk)
        code = process.wait()
        log.write(f"exit: {code}\n".encode())
    seconds = time.monotonic() - started
    summary = EVIDENCE / "summary.tsv"
    if not summary.exists():
        summary.write_text("name\texit\tseconds\tcommand\n")
    with open(summary, "a") as rows:
        rows.write(f"{name}\t{code}\t{seconds:.1f}\t{shlex.join(command)}\n")
    print(f"{name}: exit {code} in {seconds:.1f}s")
    sys.exit(code)


if __name__ == "__main__":
    main()
