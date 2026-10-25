#!/usr/bin/env python3
"""Package and serve the docs; rebuild on source edits and reap child processes."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def fingerprint(paths):
    digest = hashlib.sha256()
    for path in sorted(paths):
        if path.is_file():
            digest.update(str(path).encode())
            digest.update(path.read_bytes())
    return digest.digest()


def sources():
    # Include only declared docs and rule inputs. Exclude build artifacts and
    # generated preview files to avoid rebuild loops.
    for root in ("docs", "rules"):
        for directory, dirs, files in os.walk(root):
            dirs[:] = [
                d
                for d in dirs
                if d not in ("target", "__pycache__", ".git", "node_modules")
            ]
            for name in files:
                path = Path(directory) / name
                if root == "docs" or path.suffix in (
                    ".luau",
                    ".md",
                    ".rs",
                    ".c",
                    ".h",
                    ".json",
                    ".toml",
                    ".lock",
                ):
                    yield path
    yield Path("imp.workspace.luau")
    yield Path("imp.workspace.ci.luau")
    yield Path("BUILD.luau")


class Preview:
    def __init__(self, imp, zola, args=()):
        self.imp, self.zola, self.args = imp, zola, list(args)
        self.server = None
        self.builder = None
        self.published = None
        self.stopped = False

    def terminate(self, child):
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    def stop(self, *_):
        self.stopped = True
        self.terminate(self.builder)
        self.terminate(self.server)

    def rebuild(self):
        self.builder = subprocess.Popen(
            [self.imp, "package", "//docs:site"],
            env={**os.environ, "IMP_RUNTIME": "luau"},
        )
        status = self.builder.wait()
        self.builder = None
        if self.stopped:
            return False
        if status != 0:
            print(
                "docs preview: package failed; waiting for the next source edit",
                file=sys.stderr,
            )
            return False
        root = Path("dist/docs/site")
        published = fingerprint(root.rglob("*"))
        if (
            self.server is None
            or self.server.poll() is not None
            or published != self.published
        ):
            self.terminate(self.server)
            self.server = subprocess.Popen(
                [self.zola, "--root", str(root), "serve", *self.args]
            )
            self.published = published
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", required=True)
    parser.add_argument("--zola", required=True)
    args, server_args = parser.parse_known_args()
    # Resolve the declared tool once. Its shared native-tool link can be
    # refreshed by a different Imp process while the preview is running.
    imp = shutil.which(args.imp) or args.imp
    preview = Preview(
        str(Path(imp).resolve()), str(Path(args.zola).resolve()), server_args
    )
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, preview.stop)
    try:
        previous = fingerprint(sources())
        if not preview.rebuild():
            return 1
        while not preview.stopped:
            time.sleep(1)
            current = fingerprint(sources())
            if current != previous:
                previous = current
                preview.rebuild()
            elif preview.server.poll() is not None:
                return preview.server.returncode or 1
    finally:
        preview.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
