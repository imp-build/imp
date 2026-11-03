#!/usr/bin/env python3
"""Check the imp and imp-luau outcome comparison."""

import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compare import (
    diff_targets,
    main,
    parse_report,
    parse_targets,
    snapshot,
    split_ignored,
    written_files,
)

GREEN, RED, RESET = "\x1b[32m", "\x1b[31m", "\x1b[0m"

TARGETS = """keeping sandbox /tmp/imp/sandbox-1
//runtime:runtime (resource-package)
//core/buffer:buffer (graph)
  build
  fmt
  run
//frontend/tui:tui#program (graph, expanded)
"""

TEST_REPORT = f"""progress 1/2\rprogress 2/2
//core:a_test case one  {RED}FAIL{RESET}
//core:a_test two       {GREEN}PASS{RESET}
//core:a_test case one:
//core:a_test other  PASS
test: 1/2 unit(s) passed
"""


class ParseTest(unittest.TestCase):
    def test_targets(self):
        self.assertEqual(
            parse_targets(TARGETS),
            {
                "//runtime:runtime": ("resource-package", set()),
                "//core/buffer:buffer": ("graph", {"build", "fmt", "run"}),
                "//frontend/tui:tui#program": ("graph, expanded", set()),
            },
        )

    def test_report_stops_at_output_blocks(self):
        self.assertEqual(
            parse_report(TEST_REPORT),
            {"//core:a_test case one": "FAIL", "//core:a_test two": "PASS"},
        )

    def test_diff_targets(self):
        old = {"//:a": ("resource-package", {"build"}), "//:b": ("graph", set())}
        new = {"//:a": ("graph", {"build", "run"}), "//:c": ("graph", set())}
        differences, kinds = diff_targets(old, new, ["imp", "imp-luau"])
        self.assertEqual(
            differences,
            [
                "//:a: goals ['build'] with imp, ['build', 'run'] with imp-luau",
                "//:b: only with imp",
                "//:c: only with imp-luau",
            ],
        )
        self.assertEqual(kinds, ["//:a: resource-package -> graph"])


class SplitIgnoredTest(unittest.TestCase):
    def test_only_shared_matching_paths_move(self):
        old = {
            "dist/bin": "a",
            "dist/only-old": "c",
            "dist/out.txt": "e",
            "dist/same": "s",
        }
        new = {"dist/bin": "b", "dist/out.txt": "f", "dist/same": "s"}
        globs = ["dist/b*", "dist/only-*", "dist/s*"]
        old, new, moved = split_ignored(old, new, globs)
        self.assertEqual(moved, {"dist/bin": ("a", "b")})
        self.assertEqual(old, {"dist/only-old": "c", "dist/out.txt": "e"})
        self.assertEqual(new, {"dist/out.txt": "f"})

    def test_star_matches_slash(self):
        _, _, moved = split_ignored({"a/b/c": "x"}, {"a/b/c": "y"}, ["a/*"])
        self.assertEqual(list(moved), ["a/b/c"])


class WrittenFilesTest(unittest.TestCase):
    def test_rewrite_with_same_content_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            (root / ".git" / "HEAD").write_text("x")
            (root / "src.txt").write_text("source")
            (root / "dist").mkdir()
            (root / "dist" / "old.txt").write_text("from the previous run")
            before = snapshot(root)
            self.assertNotIn(".git/HEAD", before)
            # The file system clock is coarse. An imp run starts later than
            # one clock step after the snapshot.
            time.sleep(0.02)
            (root / "dist" / "new.txt").write_text("new")
            (root / "dist" / "old.txt").write_text("from the previous run")
            written = written_files(root, before)
            self.assertEqual(sorted(written), ["dist/new.txt", "dist/old.txt"])

    def test_untouched_file_does_not_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dist.txt").write_text("from the other binary")
            before = snapshot(root)
            self.assertEqual(written_files(root, before), {})

    def test_rewrite_that_keeps_mtime_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "out.txt").write_text("aaaa")
            mtime = (root / "out.txt").stat().st_mtime_ns
            before = snapshot(root)
            time.sleep(0.02)
            (root / "out.txt").write_text("bbbb")
            os.utime(root / "out.txt", ns=(mtime, mtime))
            self.assertEqual(list(written_files(root, before)), ["out.txt"])


FAKE_IMP = """#!/bin/sh
# A fake imp. Its outcomes depend on FLAVOR.
case "$1" in
targets)
  printf '//:lib (graph)\\n  build\\n'
  [ "$FLAVOR" = new ] && printf '  run\\n'
  ;;
test)
  printf '//:t one  PASS\\n'
  if [ "$FLAVOR" = new ]; then printf '//:t two  FAIL\\n'; exit 1; fi
  ;;
hang)
  sleep 300 &
  echo "child=$!"
  wait
  ;;
build)
  mkdir -p dist
  printf '%s' "$FLAVOR" > dist/out.txt
  printf 'same' > dist/same.txt
  ;;
esac
echo "cache=$IMP_CACHE_DIR"
"""


class EndToEndTest(unittest.TestCase):
    def fake(self, directory, flavor):
        path = Path(directory, flavor)
        path.write_text(FAKE_IMP.replace("$FLAVOR", flavor))
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def test_reports_each_difference(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory, "repo")
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            old, new = self.fake(directory, "old"), self.fake(directory, "new")
            argv = [str(repo), "--old", old, "--new", new]
            argv += ["--goal", "targets", "--goal", "test", "--goal", "build"]
            self.assertEqual(main(argv), 1)
            out = repo / ".imp-compare"
            report = (out / "report.md").read_text()
            self.assertTrue(
                report.startswith(
                    "repo: 5 difference(s) (exit 2, targets 1, units 1, outputs 1)"
                ),
                report,
            )
            self.assertIn(
                "- //:lib: goals ['build'] with old, ['build', 'run']", report
            )
            self.assertIn("- `test` //:t two: only with new (FAIL)", report)
            self.assertIn("- `build` dist/out.txt:", report)
            self.assertNotIn("dist/same.txt", report)
            self.assertNotIn("## Ignored", report)
            rows = (out / "summary.tsv").read_text().splitlines()
            self.assertEqual(rows[0], "name\texit\tseconds\tcommand")
            self.assertEqual(len(rows), 1 + 2 * 2 * 3)
            log = (out / "old-cold-test.log").read_text()
            self.assertTrue(log.startswith(f"$ {old} test //..."))
            self.assertTrue(log.endswith("exit: 0\n"))
            cache = log.split("cache=")[1].splitlines()[0]
            self.assertIn("imp-compare-old-", cache)
            self.assertFalse(Path(cache).exists())
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=repo,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertNotIn(".imp-compare", status.stdout)

    def test_ignore_marks_digest_difference(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory, "repo")
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            old, new = self.fake(directory, "old"), self.fake(directory, "new")
            argv = [str(repo), "--old", old, "--new", new, "--no-cold"]
            argv += ["--goal", "build", "--ignore", "dist/*"]
            self.assertEqual(main(argv), 0)
            report = (repo / ".imp-compare" / "report.md").read_text()
            self.assertTrue(
                report.startswith(
                    "repo: 0 difference(s) "
                    "(exit 0, targets 0, units 0, outputs 0, ignored 1)"
                ),
                report,
            )
            ignored = report.split("## Ignored written files (not counted)")[1]
            self.assertIn("Globs: `dist/*`", ignored)
            self.assertIn("- `build` dist/out.txt:", ignored)
            self.assertNotIn("dist/same.txt", ignored)

    def test_timeout_stops_the_run_and_its_children(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory, "repo")
            repo.mkdir()
            old, new = self.fake(directory, "old"), self.fake(directory, "new")
            argv = [str(repo), "--old", old, "--new", new, "--no-cold"]
            argv += ["--goal", "hang", "--timeout", "1"]
            started = time.monotonic()
            self.assertEqual(main(argv), 0)
            self.assertLess(time.monotonic() - started, 20)
            log = (repo / ".imp-compare" / "old-default-hang.log").read_text()
            self.assertTrue(log.endswith("timed out after 1.0s\nexit: 124\n"), log)
            child = int(log.split("child=")[1].splitlines()[0])
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)


if __name__ == "__main__":
    unittest.main()
