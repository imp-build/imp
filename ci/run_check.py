#!/usr/bin/env python3
"""Run one CI check and keep its command, exit code, and output as evidence.

Usage: ci/run_check.py <name> -- <command> [<argument>...]
       ci/run_check.py --exclude <name> <task>
       ci/run_check.py --gate

The output goes to the step log and to ci-evidence/<name>.log. The script
appends one row to ci-evidence/summary.tsv and exits with the exit code of the
command. A command that cannot start gets exit code 127.

--exclude records a check that the job does not run, and the task that owns
it. --gate prints the summary and fails if a check has a non-zero exit code.
The job runs each check even when an earlier check fails, and runs the gate
last. A workflow uploads ci-evidence/ as an artifact.
"""

import shlex
import subprocess
import sys
import time
from pathlib import Path

EVIDENCE = Path("ci-evidence")
SUMMARY = EVIDENCE / "summary.tsv"
EXCLUDED = "excluded"


def append_row(name, exit_code, seconds, command):
    EVIDENCE.mkdir(exist_ok=True)
    if not SUMMARY.exists():
        SUMMARY.write_text("name\texit\tseconds\tcommand\n")
    with open(SUMMARY, "a") as rows:
        rows.write(f"{name}\t{exit_code}\t{seconds}\t{command}\n")


def gate():
    if not SUMMARY.exists():
        sys.exit(f"{SUMMARY} does not exist")
    rows = SUMMARY.read_text().splitlines()
    print("\n".join(rows))
    failed = [
        row.split("\t")[0]
        for row in rows[1:]
        if row.split("\t")[1] not in ("0", EXCLUDED)
    ]
    if failed:
        sys.exit(f"failed checks: {', '.join(failed)}")


def run(name, command):
    EVIDENCE.mkdir(exist_ok=True)
    started = time.monotonic()
    with open(EVIDENCE / f"{name}.log", "wb") as log:
        log.write(f"$ {shlex.join(command)}\n".encode())
        log.flush()
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
            )
        except OSError as error:
            message = f"cannot start command: {error}\n"
            sys.stdout.write(message)
            log.write(message.encode())
            code = 127
        else:
            assert process.stdout is not None
            for chunk in process.stdout:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                log.write(chunk)
            code = process.wait()
        log.write(f"exit: {code}\n".encode())
    seconds = time.monotonic() - started
    append_row(name, code, f"{seconds:.1f}", shlex.join(command))
    print(f"{name}: exit {code} in {seconds:.1f}s")
    sys.exit(code)


def main():
    arguments = sys.argv[1:]
    if arguments == ["--gate"]:
        gate()
    elif len(arguments) == 3 and arguments[0] == "--exclude":
        append_row(arguments[1], EXCLUDED, "0.0", arguments[2])
    elif len(arguments) >= 3 and arguments[1] == "--":
        run(arguments[0], arguments[2:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
