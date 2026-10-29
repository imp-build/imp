#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter==0.26.0", "tree-sitter-javascript==0.25.0"]
# ///
"""Check the JavaScript-to-Luau converter on small repositories."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert import RuleCatalog, convert_repository

RULES = {
    "odin/index.luau": """local graph = require("./graph")
return {
	odin_package = graph.odin_package,
	odin_test_package = graph.odin_test_package,
}
""",
    "odin/graph.luau": "return { odin_package = 1, odin_test_package = 2 }\n",
    "c/gcc/index.luau": "return { default_graph_toolchain = 1, default_version = 2 }\n",
    "python/uv_toolchain.luau": "return { graph_toolchain = 1, default_version = 2 }\n",
    "python/index.luau": """local uv = require("@imp/rules/python/uv_toolchain")
return {
	uv_graph_tool = uv.graph_toolchain,
	default_uv_toolchain_version = uv.default_version,
}
""",
    "workflows/build/index.luau": "return { BUILD = 1 }\n",
    "imp/generate/index.luau": "return { generated_files = 1 }\n",
}
ENGINE = "\n".join(
    f'core.set("{name}", x)?;'
    for name in ("files", "glob", "task", "output", "package_path", "native_tool")
)


class ConverterTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        base = Path(directory.name)
        self.rules = base / "rules"
        for path, text in RULES.items():
            (self.rules / path).parent.mkdir(parents=True, exist_ok=True)
            (self.rules / path).write_text(text)
        self.core = {
            "files",
            "glob",
            "task",
            "output",
            "package_path",
            "native_tool",
        }
        self.repo = base / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def write(self, files):
        for path, text in files.items():
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True)

    def run_converter(self, force=False):
        catalog = RuleCatalog(self.rules)
        return convert_repository(self.repo, catalog, self.core, force, False)

    def read(self, path):
        return (self.repo / path).read_text()

    def test_build_module(self):
        self.write(
            {
                "imp.workspace.js": "",
                "lib/BUILD.js": "export const lib = 1;\n",
                "BUILD.js": """import { odinPackage, odinTestPackage } from "//rules/odin";
import { lib } from "//lib";
import { BUILD } from "//rules/workflows/build";

// The application.
export const app = odinPackage({ deps: [lib], unsafeSystemPaths: true });
export const app_test = odinTestPackage({ deps: [app] });
export const root = { [BUILD]: app[BUILD] };
""",
            }
        )
        report = self.run_converter()
        self.assertEqual(report["counts"]["complete"], 3)
        self.assertEqual(
            self.read("BUILD.luau"),
            """local odin = require("@imp/rules/odin")
local odinPackage = odin.odin_package
local odinTestPackage = odin.odin_test_package
local lib = require("@workspace/lib/BUILD").lib
local BUILD = require("@imp/rules/workflows/build").BUILD

-- The application.
local app = odinPackage({ deps = { lib }, unsafe_system_paths = true })
local app_test = odinTestPackage({ deps = { app } })
local root = { [BUILD] = app[BUILD] }

return { app = app, app_test = app_test, root = root }
""",
        )

    def test_workspace_configuration(self):
        self.write(
            {
                "imp.workspace.js": """import "//rules/workflows/build";
export const cache = { gcMaxAgeDays: 7 };
export const odinConfig = { buildGenerate: true };
""",
            }
        )
        self.run_converter()
        self.assertEqual(
            self.read("imp.workspace.luau"),
            """require("@imp/rules/workflows/build")

local cache = { gc_max_age_days = 7 }
local odinConfig = { build_generate = true }

return { cache = cache, odin = odinConfig }
""",
        )

    def test_module_without_exports_returns_a_table(self):
        self.write({"imp.workspace.js": 'import "//rules/workflows/build";\n'})
        self.run_converter()
        self.assertTrue(self.read("imp.workspace.luau").endswith("return {}\n"))

    def test_core_files_tools_and_closures(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """import { file, files } from "imp:core";
import { generatedFiles } from "//rules/imp/generate";
import { nativeTool } from "//rules/imp/native-tool";

const OUTS = ["a.txt", "b.txt"];
export const gen = generatedFiles({
	tools: { python3: nativeTool("python3") },
	inputs: { script: file("gen.py"), data: files({ root: "data", include: ["*.json"] }) },
	outputPaths: OUTS,
	argv: (exec, { python3 }) => [exec.tool(python3, "python3"), "gen.py", ...OUTS],
});
""",
            }
        )
        report = self.run_converter()
        text = self.read("BUILD.luau")
        self.assertIn('script = core.files({ paths = { "gen.py" } })', text)
        self.assertIn(
            'data = core.glob({ root = "data", include = { "*.json" } })', text
        )
        self.assertIn("output_paths = OUTS", text)
        self.assertIn("local python3 = resolved.python3", text)
        self.assertIn('array_concat({ "python3", "gen.py" }, OUTS)', text)
        self.assertIn('local core = require("@imp/core")', text)
        # native-tool is not in the fake catalog, so its import is marked.
        self.assertEqual(report["counts"]["markers"], 1)

    def test_rename_from_alias_and_tool_prefix(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """import { uvGraphTool, defaultUvToolchainVersion } from "//rules/python/uv_toolchain";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
export const uv = uvGraphTool(defaultUvToolchainVersion());
export const gcc = defaultGccGraphToolchain();
""",
            }
        )
        report = self.run_converter()
        text = self.read("BUILD.luau")
        self.assertIn("local uvGraphTool = uv_toolchain.graph_toolchain", text)
        self.assertIn(
            "local defaultUvToolchainVersion = uv_toolchain.default_version", text
        )
        self.assertIn('require("@imp/rules/c/gcc").default_graph_toolchain', text)
        self.assertEqual(report["counts"]["markers"], 0)
        renames = next(f for f in report["files"] if f["source"] == "BUILD.js")[
            "renames"
        ]
        self.assertEqual(len(renames), 3)

    def test_marker_location_and_failure(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """import { odinPackage, missingRule } from "//rules/odin";

const names = ["a", "b"];
export const app = odinPackage({ srcs: names.slice(1) });
""",
            }
        )
        report = self.run_converter()
        entry = report["files"][0]
        self.assertEqual(entry["source"], "BUILD.js")
        self.assertEqual(entry["status"], "marked")
        reasons = [(m["source_line"], m["reason"]) for m in entry["markers"]]
        self.assertEqual(
            reasons,
            [
                (
                    1,
                    "@imp/rules/odin has no export for 'missingRule' (no matching export)",
                ),
                (4, "JavaScript method '.slice()'"),
            ],
        )
        lines = self.read("BUILD.luau").split("\n")
        for marker in entry["markers"]:
            self.assertIn("IMP-PORT#", lines[marker["output_line"] - 1])
        self.assertIn(
            "srcs = error(\"IMP-PORT#2 BUILD.js:4: JavaScript method '.slice()'\")",
            self.read("BUILD.luau"),
        )

    def test_existing_luau_file_is_kept_without_force(self):
        self.write({"imp.workspace.js": "export const imp = { jobs: 2 };\n"})
        (self.repo / "imp.workspace.luau").write_text("-- hand port\n")
        report = self.run_converter()
        self.assertEqual(report["counts"]["skipped"], 1)
        self.assertEqual(self.read("imp.workspace.luau"), "-- hand port\n")
        self.run_converter(force=True)
        self.assertIn("jobs = 2", self.read("imp.workspace.luau"))

    def test_output_outside_repository_is_rejected(self):
        outside = self.repo.parent / "outside.luau"
        self.write({"imp.workspace.js": "export const imp = { jobs: 2 };\n"})
        (self.repo / "imp.workspace.luau").symlink_to(outside)
        with self.assertRaises(ValueError):
            self.run_converter(force=True)
        self.assertFalse(outside.exists())

    def test_javascript_semantics(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """import { odinPackage } from "//rules/odin";
import { BUILD } from "//rules/workflows/build";
const items = ["x", "y"];
const out = [a, b].filter(Boolean).join("\\n");
const first = items[0];
const label = `v${version}-{x}`;
const ok = result.exitCode === 0 ? "yes" : "no";
const project = odinPackage({});
const child = project.get("lib", BUILD);
const slot = project[BUILD];
export function later() { return helper(); }
function helper() { return 1; }
""",
            }
        )
        report = self.run_converter()
        self.assertEqual(report["counts"]["markers"], 0)
        text = self.read("BUILD.luau")
        self.assertIn('table.concat(array_truthy({ a, b }), "\\n")', text)
        self.assertIn("local first = items[1]", text)
        self.assertIn("local label = `v{version}-\\{x}`", text)
        self.assertIn('if result.exit_code == 0 then "yes" else "no"', text)
        self.assertIn('project:get("lib", BUILD)', text)
        self.assertIn("local slot = project[BUILD]", text)
        self.assertIn("local helper\n", text)
        self.assertIn("function helper()", text)
        self.assertNotIn("local function helper()", text)

    def reasons(self, report, source="BUILD.js"):
        entry = next(f for f in report["files"] if f["source"] == source)
        return [m["reason"] for m in entry["markers"]]

    def test_marks_javascript_truthiness(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """const a = list.length ? "some" : "none";
const b = !arr.length;
const c = opts.name || "default";
const d = lines.filter((l) => l.length);
const e = opts.debug ?? true;
const f = (x > 1) && (y < 2);
""",
            }
        )
        report = self.run_converter()
        self.assertEqual(
            self.reasons(report),
            [
                "JavaScript truthiness of a '?:' condition: 0 and \"\" are true in Luau",
                "JavaScript truthiness of '!' operand: 0 and \"\" are true in Luau",
                "JavaScript truthiness of the left operand of '||': 0 and \"\" are true in Luau",
                'JavaScript truthiness of a filter callback result: 0 and "" are true in Luau',
            ],
        )
        text = self.read("BUILD.luau")
        self.assertIn("local e = if opts.debug == nil then true else opts.debug", text)
        self.assertIn("local f = (x > 1) and (y < 2)", text)
        self.assertIn('error("IMP-PORT: 4 unconverted construct(s) in BUILD.js")', text)

    def test_key_names_stay_consistent(self):
        self.write(
            {
                "imp.workspace.js": "",
                "lib/BUILD.js": "export const myLib = 1;\n",
                "gen/BUILD.js": (
                    'import { task } from "imp:core";\n'
                    "export const gen = task({ outputs: { genDir: 1 } });\n"
                ),
                "BUILD.js": """import * as lib from "//lib";
import { gen } from "//gen";
const obj = { "fooBar": 1, bazQux: 2 };
const x = obj["bazQux"];
const { "fooBar": fb } = obj;
const y = lib.myLib;
const z = gen.outputs.genDir;
const opts = someRule({ outDir: "dist", env: { Path: "x", myVar: "y" } });
const t = task({ inputs: { outDir: 1 } });
""",
            }
        )
        report = self.run_converter()
        self.assertEqual(
            self.reasons(report), ["quoted read of the camelCase key 'bazQux'"]
        )
        text = self.read("BUILD.luau")
        self.assertIn("local obj = { fooBar = 1, baz_qux = 2 }", text)
        self.assertIn("local fb = obj.fooBar", text)
        self.assertIn("local y = lib.myLib", text)
        self.assertIn("local z = gen.outputs.genDir", text)
        self.assertIn('out_dir = "dist"', text)
        self.assertIn('env = { Path = "x", myVar = "y" }', text)
        self.assertIn("inputs = { outDir = 1 }", text)

    def test_marks_unsafe_conversions(self):
        self.write(
            {
                "imp.workspace.js": "",
                "BUILD.js": """import { glob } from "imp:core";
const IDX = 1;
const parts = ["a"];
const flagList = ["-a", "-b"];
const cfg = { get: (k) => k };
// [[ not a long comment
const after = 1;
const a = `flags: ${flagList}`;
const b = cfg.get("k");
const c = parts[IDX];
const d = name[0];
const e = f?.(1);
for (const i in parts) { use(i); }
function outer() {
	return inner();
	function inner() { return 1; }
}
export { glob };
""",
            }
        )
        report = self.run_converter()
        self.assertEqual(
            self.reasons(report),
            [
                "interpolation of a table: JavaScript joins arrays",
                "index may be a zero-based array index",
                "index of a value that is not known to be an array",
                "optional call",
                "for...in yields string keys; Luau keys differ",
            ],
        )
        text = self.read("BUILD.luau")
        self.assertIn("-- [[ not a long comment\nlocal after = 1", text)
        self.assertIn('local b = cfg.get("k")', text)
        self.assertIn("\tlocal inner\n\treturn inner()\n\tfunction inner()", text)
        self.assertIn("glob = core.glob", text)

    def test_custom_module_import_is_its_own_status(self):
        self.write(
            {
                "imp.workspace.js": "",
                "helpers.js": "import { glob } from 'imp:core';\nexport const x = 1;\n",
                "other.js": "import { task } from 'imp:core';\n",
                "BUILD.js": 'import { x } from "//helpers";\nexport const y = x;\n',
            }
        )
        report = self.run_converter()
        entry = next(f for f in report["files"] if f["source"] == "BUILD.js")
        self.assertEqual(entry["status"], "needs-custom-modules")
        self.assertEqual(report["custom_modules"], ["helpers.js", "other.js"])

    def test_unencodable_output_fails_one_file(self):
        self.write(
            {"imp.workspace.js": "", "BUILD.js": 'export const s = "\\uD83D";\n'}
        )
        report = self.run_converter()
        entry = next(f for f in report["files"] if f["source"] == "BUILD.js")
        self.assertTrue(entry["status"].startswith("failed"), entry["status"])
        self.assertFalse((self.repo / "BUILD.luau").exists())
        self.assertTrue((self.repo / "imp.workspace.luau").exists())

    def test_custom_modules_are_listed(self):
        self.write(
            {
                "imp.workspace.js": "",
                "rules/site/index.js": 'import { task } from "imp:core";\nexport const siteRule = 1;\n',
                "rules/site/site_test.js": 'import { siteRule } from "//rules/site";\n',
                "BUILD.js": 'import { siteRule } from "//rules/site";\nexport const site = siteRule();\n',
                "assets/app.js": "console.log(1);\n",
            }
        )
        report = self.run_converter()
        self.assertEqual(report["custom_modules"], ["rules/site/index.js"])
        self.assertEqual(report["custom_tests"], ["rules/site/site_test.js"])
        self.assertIn(
            'local siteRule = require("@workspace/rules/site").site_rule',
            self.read("BUILD.luau"),
        )


if __name__ == "__main__":
    unittest.main()
