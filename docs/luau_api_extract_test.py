"""Exercise the real Luau grammar, export resolver, and reference renderer."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from luau_api_extract import Catalog, ExtractionError, render, schema_markdown, tags


@unittest.skipUnless(
    os.environ.get("IMP_LUAU_EXTRACTOR") and os.environ.get("IMP_LUAU_GRAMMAR"),
    "run through //docs:quality_tests for graph-built parser inputs",
)
class ExtractionTests(unittest.TestCase):
    def parse(self, sources):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path, text in sources.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            (root / "manifest.json").write_text(json.dumps(list(sources)))
            result = subprocess.run(
                [
                    str(Path(os.environ["IMP_LUAU_EXTRACTOR"]).resolve()),
                    str(Path(os.environ["IMP_LUAU_GRAMMAR"]).resolve()),
                    "manifest.json",
                ],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode:
                raise ExtractionError(result.stderr)
            return json.loads(result.stdout)

    def test_typed_functions_comments_interpolation_and_reexports(self):
        modules = self.parse(
            {
                "rules/demo/implementation.luau": "--- Build a demo.\n--- @param value A string input.\n--- @returns The result.\n--- @category target\nlocal function build(value: string): string\n return `value: {value}`\nend\nreturn table.freeze({ build = build })",
                "rules/demo/index.luau": 'local implementation = require("./implementation")\nlocal alias = implementation\nreturn { demo = alias.build }',
                "rules/alias/index.luau": 'return require("@imp/rules/demo")',
            }
        )
        catalog = Catalog(modules)
        entry = catalog.exports("rules/alias/index.luau")["demo"]
        self.assertEqual(entry["signature"], "(value: string)")
        self.assertEqual(entry["source"], "rules/demo/implementation.luau")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            render(modules, {}, root, {})
            self.assertEqual(
                (root / "user-api/demo/_index.md").read_text().count("Build a demo"), 1
            )
            first = {
                str(p.relative_to(root)): p.read_bytes()
                for p in root.rglob("*")
                if p.is_file()
            }
            with tempfile.TemporaryDirectory() as other:
                render(dict(reversed(list(modules.items()))), {}, Path(other), {})
                second = {
                    str(p.relative_to(other)): p.read_bytes()
                    for p in Path(other).rglob("*")
                    if p.is_file()
                }
            self.assertEqual(first, second)

    def test_tags_do_not_leak_to_adjacent_inline_fields(self):
        modules = self.parse(
            {
                "rules/demo/index.luau": "return {\n--- Public factory.\n--- @category target\npublic = function() end, internal = function() end,\n}"
            }
        )
        exports = Catalog(modules).exports("rules/demo/index.luau")
        self.assertEqual(tags(exports["public"]["doc"])[0], "target")
        self.assertEqual(tags(exports["internal"]["doc"])[0], "api")

    def test_duplicate_exports_fail(self):
        modules = self.parse({"rules/demo/index.luau": "return { item = 1, item = 2 }"})
        with self.assertRaisesRegex(ExtractionError, "duplicate export"):
            Catalog(modules).exports("rules/demo/index.luau")

    def test_cycles_and_unknown_exports_fail(self):
        modules = self.parse(
            {
                "rules/a/index.luau": 'return require("@imp/rules/b")',
                "rules/b/index.luau": 'return require("@imp/rules/a")',
            }
        )
        with self.assertRaisesRegex(ExtractionError, "cyclic re-export"):
            Catalog(modules).exports("rules/a/index.luau")
        modules = self.parse({"rules/demo/index.luau": "return make_exports()"})
        with self.assertRaisesRegex(ExtractionError, "static export table"):
            Catalog(modules).exports("rules/demo/index.luau")

    def test_missing_names_and_mutated_exports_fail(self):
        modules = self.parse({"rules/demo/index.luau": "return { item = missing }"})
        with self.assertRaisesRegex(ExtractionError, "unresolved export"):
            Catalog(modules).exports("rules/demo/index.luau")
        modules = self.parse(
            {
                "rules/demo/index.luau": "local exports = {}\nexports.item = 1\nreturn exports"
            }
        )
        with self.assertRaisesRegex(ExtractionError, "mutated export table"):
            Catalog(modules).exports("rules/demo/index.luau")

    def test_malformed_source_fails(self):
        with self.assertRaisesRegex(ExtractionError, "syntax error"):
            self.parse({"rules/demo/index.luau": "return { broken = function( end }"})

    def test_aliased_and_conditional_export_mutations_fail(self):
        writes = (
            "local alias = exports\nalias.item = function() end",
            "if true then exports.item = function() end end",
            "if true then local alias = exports\nalias.item = function() end end",
            'exports ["item"] = 1',
            "exports.item += 1",
            "function exports.item() end",
        )
        for write in writes:
            with self.subTest(write=write):
                modules = self.parse(
                    {
                        "rules/demo/index.luau": f"local exports = {{}}\n{write}\nreturn exports"
                    }
                )
                with self.assertRaisesRegex(ExtractionError, "mutated export table"):
                    Catalog(modules).exports("rules/demo/index.luau")

    def test_constants_and_empty_extension_modules(self):
        modules = self.parse(
            {
                "rules/demo/index.luau": 'return { patterns = { "*.c", "*.h" }, inline = function() return true end }',
                "rules/extension/index.luau": "return {}",
            }
        )
        self.assertEqual(
            set(Catalog(modules).exports("rules/demo/index.luau")),
            {"patterns", "inline"},
        )
        self.assertEqual(Catalog(modules).exports("rules/extension/index.luau"), {})


class RendererTests(unittest.TestCase):
    def test_configuration_uses_luau_field_descriptors(self):
        text = schema_markdown(
            {"build_generate": {"__imp_field": "bool", "default": False}}
        )
        self.assertIn("| `build_generate` | `bool` | `false` |", text)
        self.assertNotIn("export const", text)

    def test_field_category_overrides_definition_and_unknown_category_fails(self):
        self.assertEqual(tags("@category api\n@category target")[0], "target")
        with self.assertRaisesRegex(ExtractionError, "unknown documentation category"):
            tags("@category typo")
