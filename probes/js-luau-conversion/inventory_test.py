"""Check cutover audit failures without changing the repository."""

import copy
from pathlib import Path
import tempfile
import unittest

from inventory import audit


class CutoverAuditTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for path in ("app.js", "app.ts", "replacement.luau", "evidence.md"):
            (self.root / path).write_text("", encoding="utf-8")
        self.tracked = {"old.js", "app.js", "app.ts", "replacement.luau", "evidence.md"}
        self.manifest = {
            "version": 1,
            "retained_inputs": ["app.js", "app.ts"],
            "removed_authoring": [
                {
                    "source": "old.js",
                    "replacements": ["replacement.luau"],
                    "evidence": ["evidence.md"],
                }
            ],
        }

    def check(self):
        return audit(self.root, self.manifest, self.tracked)

    def test_pending_deletion_and_retained_inputs_pass(self):
        self.assertEqual(self.check(), [])
        self.tracked.remove("old.js")
        self.assertEqual(self.check(), [])

    def test_missing_removal_record_fails_for_absent_tracked_source(self):
        self.manifest["removed_authoring"] = []
        self.assertIn(
            "unexpected tracked JavaScript/TypeScript file: old.js", self.check()
        )

    def test_remaining_authoring_and_unexpected_source_fail(self):
        (self.root / "old.js").write_text("")
        self.assertTrue(any("obsolete authoring" in e for e in self.check()))
        (self.root / "new.mjs").write_text("")
        self.tracked.add("new.mjs")
        self.assertIn(
            "unexpected tracked JavaScript/TypeScript file: new.mjs", self.check()
        )

    def test_duplicate_and_conflicting_records_fail(self):
        row = copy.deepcopy(self.manifest["removed_authoring"][0])
        self.manifest["removed_authoring"].append(row)
        self.assertIn("duplicate removed source: old.js", self.check())
        self.manifest["retained_inputs"].append("old.js")
        self.assertIn("source is both removed and retained: old.js", self.check())

    def test_missing_replacement_and_evidence_fail(self):
        for name in ("replacement.luau", "evidence.md"):
            with self.subTest(path=name):
                path = self.root / name
                path.unlink()
                self.assertTrue(any(name in e for e in self.check()))
                path.write_text("")

    def test_missing_retained_input_and_untracked_input_fail(self):
        (self.root / "app.ts").unlink()
        self.assertIn("missing retained input: app.ts", self.check())
        self.tracked.remove("app.js")
        self.assertIn("retained input is not tracked: app.js", self.check())

    def test_exclusion_and_coverage_gap_are_explicit(self):
        row = self.manifest["removed_authoring"][0]
        del row["replacements"]
        row["exclusion"] = "Removed host API; see evidence."
        self.assertEqual(self.check(), [])
        row["coverage_gap"] = {"description": "Retained behavior lacks a test."}
        self.assertTrue(any("follow-up" in e for e in self.check()))
        row["coverage_gap"]["follow_up"] = "imp:follow-up"
        self.assertEqual(self.check(), [])

    def test_unsafe_paths_fail(self):
        self.manifest["removed_authoring"][0]["replacements"] = ["../outside"]
        with self.assertRaises(ValueError):
            self.check()


if __name__ == "__main__":
    unittest.main()
