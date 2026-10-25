import json
import tempfile
import unittest
from pathlib import Path

from quality_check import (
    check_api_reference,
    check_examples,
    check_luau_authoring,
    check_navigation,
    check_rendered_links,
    check_rule_namespace_guides,
)


class QualityCheckTest(unittest.TestCase):
    def test_rendered_links_report_missing_targets_and_fragments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text(
                '<a href="/guide/missing/">missing</a><a href="/guide/ok/#nope">anchor</a>',
                encoding="utf-8",
            )
            (root / "guide/ok").mkdir(parents=True)
            (root / "guide/ok/index.html").write_text(
                '<h1 id="present">ok</h1>', encoding="utf-8"
            )
            errors = check_rendered_links(root)
            self.assertEqual(len(errors), 2)
            self.assertIn("missing link target", errors[0])
            self.assertIn("missing fragment", errors[1])

    def test_navigation_reports_orphaned_guide_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "guide/one").mkdir(parents=True)
            (root / "guide/two").mkdir(parents=True)
            (root / "guide/one/index.html").write_text(
                '<nav class="docs-sidebar"><a href="/guide/one/">one</a></nav>',
                encoding="utf-8",
            )
            (root / "guide/two/index.html").write_text(
                '<nav class="docs-sidebar"><a href="/guide/one/">one</a></nav>',
                encoding="utf-8",
            )
            errors = check_navigation(root)
            self.assertEqual(
                errors, ["guide page is not present in guide navigation: /guide/two/"]
            )

    def test_guide_examples_need_an_explicit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docs/content/guide/example.md"
            path.parent.mkdir(parents=True)
            path.write_text("```sh\nimp test //docs\n```\n", encoding="utf-8")
            self.assertEqual(len(check_examples([path])), 1)
            path.write_text(
                "**Illustrative example**\n\n```sh\nimp test //docs\n```\n",
                encoding="utf-8",
            )
            self.assertEqual(check_examples([path]), [])

    def test_generated_reference_manifest_detects_page_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = root / "api"
            api.mkdir()
            (root / "source.luau").write_text(
                "export const source = 1;\n", encoding="utf-8"
            )
            (api / "manifest.json").write_text(
                json.dumps(
                    {"sources": ["source.luau"], "pages": ["luau-api/source.md"]}
                ),
                encoding="utf-8",
            )
            (api / "luau-api").mkdir()
            (api / "luau-api/other.md").write_text("stale\n", encoding="utf-8")
            errors = check_api_reference(root, api)
            self.assertEqual(len(errors), 1)
            self.assertIn("page set differs", errors[0])

    def test_rule_namespace_guides_require_public_api_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for namespace in (
                "asset",
                "c",
                "imp",
                "init",
                "js",
                "oci",
                "odin",
                "python",
                "rust",
                "treesitter",
                "workflows",
                "zola",
            ):
                path = root / "rules" / namespace / "DOC.md"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("# Guide\n\n## Public API\n", encoding="utf-8")
            (root / "rules" / "js" / "DOC.md").write_text("# Guide\n", encoding="utf-8")
            errors = check_rule_namespace_guides(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("Public API section", errors[0])


if __name__ == "__main__":
    unittest.main()


class LuauAuthoringTests(unittest.TestCase):
    def test_obsolete_authoring_instructions_fail(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "guide.md"
            path.write_text("Create imp.workspace.js and BUILD.js; import imp:core.")
            self.assertEqual(len(check_luau_authoring([path])), 3)
            path.write_text(
                "Create imp.workspace.luau and BUILD.luau; require @imp/core."
            )
            self.assertEqual(check_luau_authoring([path]), [])
