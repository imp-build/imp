"""Check Luau Biome workflows with real tools in an isolated workspace."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[3]
    env = {**os.environ, "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-biome-consumer-") as directory:
        root = Path(directory)
        workspace = '''require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
local biome = require("@imp/rules/js/biome")
require("@imp/rules/js/biome/lint")
return {}
'''
        (root / "imp.workspace.luau").write_text(workspace)
        (root / "BUILD.luau").write_text('return { sources = require("@imp/rules/js").js_sources() }\n')
        nested = root / "nested space"
        nested.mkdir()
        (nested / "BUILD.luau").write_text((root / "BUILD.luau").read_text())
        source = nested / "two words.js"
        source.write_text('const value={a:1};console.log(value)\n')

        def run(*arguments, success=True, expected=None):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert (result.returncode == 0) == success, result.returncode
            if expected:
                assert expected in result.stdout + result.stderr
            return result

        run("@biome", "--version", expected="2.5.4")
        original = source.read_bytes()
        run("fmt", "--check", "//nested space:sources", success=False)
        assert source.read_bytes() == original
        run("fmt", "//nested space:sources")
        assert source.read_bytes() != original
        run("fmt", "--check", "//nested space:sources")
        run("fmt", "//:sources")
        (root / "root.js").write_text('console.log(  "root" )\n')
        run("fmt", "--check", "//:sources", success=False)
        run("fmt", "//:sources")
        run("fmt", "--check", "//:sources")
        (nested / 'biome.json').write_text('{"linter":{"rules":{"style":{"useConst":"error"}}}}')
        source.write_text('let value = 1;\nconsole.log(value);\n')
        original = source.read_bytes()
        run("lint", "//nested space:sources", success=False)
        assert source.read_bytes() == original
        run("lint", "--fix", "//nested space:sources")
        assert "const value" in source.read_text()
        run("lint", "//nested space:sources")
        source.write_text('const = ;\n')
        original = source.read_bytes()
        run("fmt", "//nested space:sources", success=False)
        assert source.read_bytes() == original

        # Applications do not include Biome configuration in their source set.
        # Check both factories and both configuration extensions with real tools.
        for factory in ["js_app", "ts_app"]:
            for extension in ["json", "jsonc"]:
                name = f"{factory}-{extension}"
                app = root / name
                (app / "src").mkdir(parents=True)
                suffix = "ts" if factory == "ts_app" else "js"
                (app / "BUILD.luau").write_text(
                    'return { app = require("@imp/rules/js").' + factory
                    + '({ sources = { "src/**/*.' + suffix + '" } }) }\n'
                )
                app_source = app / "src" / f"index.{suffix}"
                app_source.write_text('console.log("hello");\n')
                config = app / f"biome.{extension}"
                settings = {"linter": {"rules": {"suspicious": {"noConsole": "off"}}},
                            "javascript": {"formatter": {"quoteStyle": "single"}}}
                config.write_text(json.dumps(settings))
                address = f"//{name}:app"
                run("lint", address)
                # A config-only edit must invalidate the previous clean result.
                settings["linter"]["rules"]["suspicious"]["noConsole"] = "error"
                config.write_text(json.dumps(settings))
                original = app_source.read_bytes()
                run("lint", address, success=False, expected="noConsole")
                assert app_source.read_bytes() == original
                run("fmt", "--check", address, success=False)
                assert app_source.read_bytes() == original
                run("fmt", address)
                assert "'hello'" in app_source.read_text()
                run("fmt", "--check", address)

        # Source collections also need jsonc as a configuration dependency.
        (nested / "biome.json").unlink()
        (nested / "biome.jsonc").write_text(json.dumps(settings))
        source.write_text('console.log("hello");\n')
        run("lint", "//nested space:sources", success=False, expected="noConsole")

        # Produce a local executable artifact without host-path access.
        local = '''local core = require("@imp/core")
local source = core.task({ outputs = { file = core.output.artifact() }, run = function(exec)
    return { file = exec.file({ path = "local-biome", contents = "#!/bin/sh\\necho local-one\\necho $0\\n" }) }
end })
biome.install_biome_toolchain("local", core.path(source.outputs.file), { default = true })
'''
        (root / "imp.workspace.luau").write_text(workspace.replace("return {}", local + "return {}"))
        first_local = run("@biome", "--version", expected="local-one")
        # Same version, different source bytes must select a different cache.
        (root / "imp.workspace.luau").write_text((root / "imp.workspace.luau").read_text().replace("local-one", "local-two").replace("core.path(source.outputs.file)", "source.outputs.file"))
        second_local = run("@biome", "--version", expected="local-two")
        first_path = next(line for line in first_local.stdout.splitlines() if "biome-local-toolchains" in line)
        second_path = next(line for line in second_local.stdout.splitlines() if "biome-local-toolchains" in line)
        assert first_path != second_path
    print("Luau Biome consumer check passed")


if __name__ == "__main__":
    main()
