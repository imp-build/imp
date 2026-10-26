"""Check Luau Zola acquisition and site builds with real sandboxed actions."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

WORKSPACE = '''require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
return {}
'''
BUILD = '''local core = require("@imp/core")
local zola = require("@imp/rules/zola")
local package = require("@imp/rules/workflows/package")
local build = require("@imp/rules/workflows/build")
local site = core.task({
    inputs = {
        zola = zola.graph_toolchain().tool,
        sources = core.files({ root = "site", include = { "**/*" } }),
    },
    outputs = { site = core.output.artifact() },
    run = function(exec, inputs)
        local exe = zola.zola_bin(exec, inputs.zola)
        local version = exec.action({ argv = { exe, "--version" } })
        assert(string.find(version.stdout, "0.23.6", 1, true), version.stdout)
        local result = exec.action({
            argv = { exe, "--root", "site", "build", "--output-dir", "public", "--force" },
            inputs = { inputs.sources },
            outputs = { site = core.output.directory("public") },
        })
        return { site = result.outputs.site }
    end,
})
return { site = { [build.BUILD] = site.outputs.site, [package.PACKAGE] = site.outputs.site } }
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-zola-consumer-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text(WORKSPACE)
        (root / "BUILD.luau").write_text(BUILD)
        for name in ["content", "templates"]:
            (root / "site" / name).mkdir(parents=True)
        config = root / "site/config.toml"
        config.write_text('base_url = "https://example.invalid"\n')
        (root / "site/templates/index.html").write_text('<html><body>{{ section.content | safe }}</body></html>\n')
        content = root / "site/content/_index.md"
        content.write_text('+++\n+++\nFirst site content\n')

        def run(*arguments, failure=False):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert (result.returncode != 0) == failure, result.returncode
            return result.stdout + result.stderr

        run("build", "//:site")
        run("package", "//:site")
        html = root / "dist/site/index.html"
        assert "First site content" in html.read_text()
        assert not (root / "site/public").exists()
        assert not (root / "public").exists()
        content.write_text('+++\n+++\nChanged site content\n')
        run("package", "//:site")
        assert "Changed site content" in html.read_text()
        assert "First site content" not in html.read_text()
        config.write_text('base_url = [\n')
        failed = run("build", "//:site", failure=True)
        assert "TOML parse error" in failed, failed
        assert not (root / "site/public").exists()
        assert not (root / "public").exists()
    print("Luau Zola consumer check passed: version, site, packaging, source edits, and failure propagation")


if __name__ == "__main__":
    main()
