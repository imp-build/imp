"""Check Luau Tree-sitter roots with real actions in an external workspace."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

WORKSPACE = '''require("@imp/rules/workflows/build")
require("@imp/rules/workflows/test")
return {}
'''
BUILD = '''local core = require("@imp/core")
local treesitter = require("@imp/rules/treesitter")
local package = require("@imp/rules/workflows/package")
local build = require("@imp/rules/workflows/build")
local sources = core.files({ include = { "sample.odin", "expected.txt" } })
local function analysis(missing)
    return core.task({
        inputs = { bin = treesitter.odin_analyzer[package.PACKAGE], grammar = treesitter.odin_grammar_fixture.archive, sources = sources },
        outputs = { checked = core.output.value() },
        run = function(exec, input)
            local result = exec.action({
                argv = { exec.path(input.bin), exec.path(input.grammar), if missing then "missing.odin" else "sample.odin" },
                inputs = { input.bin, input.grammar, input.sources },
            })
            local value = core.json_decode(result.stdout).files["sample.odin"]
            local expected = core.read_file_in_digest(exec.digest(input.sources), "expected.txt")
            assert(#value.imports == 1 and value.imports[1] == expected, result.stdout)
            assert(value.hasMainEntrypoint == (expected == "core:fmt"), result.stdout)
            return { checked = true }
        end,
    })
end
return {
    roundtrip = treesitter.roundtrip,
    analysis = { [build.BUILD] = analysis(false) },
    missing = { [build.BUILD] = analysis(true) },
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-treesitter-consumer-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text(WORKSPACE)
        (root / "BUILD.luau").write_text(BUILD)

        def run(*arguments, failure=False):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            assert (result.returncode != 0) == failure, result.returncode
            return result.stdout + result.stderr

        run("test", "//:roundtrip")
        source = root / "sample.odin"
        expected = root / "expected.txt"
        source.write_text('package sample\nimport "core:fmt"\nmain :: proc() {}\n')
        expected.write_text("core:fmt")
        run("build", "//:analysis")
        source.write_text('package sample\nimport "core:os"\n')
        expected.write_text("core:os")
        run("build", "//:analysis")
        failed = run("build", "//:missing", failure=True)
        assert "read Odin source missing.odin" in failed, failed
    print("Luau Tree-sitter consumer check passed: round-trip, Odin analysis, source edits, and failure propagation")


if __name__ == "__main__":
    main()
