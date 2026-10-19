"""Check the Luau JS/TS rules in an isolated workspace with real tools."""
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
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    with tempfile.TemporaryDirectory(prefix="imp-js-consumer-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text('require("@imp/rules/workflows/build")\nrequire("@imp/rules/workflows/run")\nreturn {}\n')
        (root / "BUILD.luau").write_text('''local js = require("@imp/rules/js")
local node = require("@imp/rules/js/node")
local pnpm = require("@imp/rules/js/pnpm")
node.node_toolchain("22.11.0", { default = true })
pnpm.pnpm_toolchain("11.13.0", { default = true })
return {
    sources = js.js_sources({ src = "javascript" }),
    javascript = js.js_app({ src = "javascript", entry = "src/index.js", sources = { "src/**/*.js" } }),
    typescript = js.ts_app({ src = "typescript", entry = "index.js", sources = { "src/**/*.ts" } }),
}
''')
        for name in ["javascript", "typescript"]:
            app = root / name
            (app / "src").mkdir(parents=True)
            manifest = {"name": name, "private": True, "devDependencies": {"typescript": "5.7.3"}}
            if name == "javascript":
                # Install sees only manifests. Application sources arrive later.
                manifest["scripts"] = {"postinstall": "node -e \"if(require('fs').existsSync('src/index.js')) process.exit(8)\""}
            (app / "package.json").write_text(json.dumps(manifest))
            (app / "pnpm-lock.yaml").write_text((rules / "js/example/app_ts/pnpm-lock.yaml").read_text())
        (root / "javascript/src/index.js").write_text('console.log("js:" + require("typescript").version + ":" + process.argv.slice(2).join("|")); if (process.argv.includes("fail")) process.exit(9);\n')
        (root / "typescript/src/index.ts").write_text('import { version } from "typescript"; console.log("ts:" + version + ":" + (globalThis as any).process.argv.slice(2).join("|"));\n')
        (root / "typescript/tsconfig.json").write_text(json.dumps({"compilerOptions": {"outDir": "dist", "target": "ES2020", "module": "commonjs", "skipLibCheck": True}, "include": ["src/**/*.ts"]}))

        def run(*arguments, expected=None, failure=False):
            command = [str(binary), *arguments]
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout + result.stderr, flush=True)
            if failure:
                assert result.returncode != 0 and "exit code 9" in result.stdout + result.stderr
            else:
                assert result.returncode == 0, result.returncode
                if expected:
                    assert expected in result.stdout, result.stdout
            return result

        run("build", "//:sources", "//:javascript", "//:typescript")
        run("run", "//:javascript", "--", "one", "two words", expected="js:5.7.3:one|two words")
        run("run", "//:typescript", "--", "one", "two words", expected="ts:5.7.3:one|two words")
        run("run", "//:javascript", "--", "fail", failure=True)
        # A source edit must not make installation see application sources.
        with (root / "javascript/src/index.js").open("a") as source:
            source.write('console.log("edited");\n')
        run("run", "//:javascript", expected="edited")
        empty = root / "empty"
        empty.mkdir()
        (empty / "imp.workspace.luau").write_text((root / "imp.workspace.luau").read_text())
        (empty / "BUILD.luau").write_text('''local js = require("@imp/rules/js")
require("@imp/rules/js/node").node_toolchain("22.11.0", { default = true })
require("@imp/rules/js/pnpm").pnpm_toolchain("11.13.0", { default = true })
return { app = js.js_app({ entry = "index.js" }) }
''')
        (empty / "package.json").write_text('{"name":"empty","private":true}')
        (empty / "pnpm-lock.yaml").write_text((rules / "js/example/app/pnpm-lock.yaml").read_text())
        (empty / "index.js").write_text('console.log("empty application");')
        result = subprocess.run([str(binary), "run", "//:app"], cwd=empty, env=env, text=True, capture_output=True)
        print(result.stdout + result.stderr, flush=True)
        assert result.returncode == 0 and "empty application" in result.stdout
        assert not (empty / "node_modules").exists()
        for name in ["javascript", "typescript"]:
            assert not (root / name / "node_modules").exists()
            assert not (root / name / "dist").exists()
    print("Luau JS/TS consumer check passed")


if __name__ == "__main__":
    main()
