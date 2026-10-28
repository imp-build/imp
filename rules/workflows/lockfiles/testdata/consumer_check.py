"""Check Luau lockfile generation with the host download and hash tools.

The default check locks a local artifact through a selectorless goal. With
--real-lockfile, the check also regenerates the shipped luau-analyze lockfile
from its real downloads and compares the bytes.
"""

import argparse
import filecmp
import functools
import hashlib
import http.server
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[4]
SHIPPED_ANALYZER_LOCK = REPOSITORY / "rules/imp/luau/luau-analyze.lock"
ANALYZER_WORKSPACE = """require("@imp/rules/workflows/lockfiles")
local luau = require("@imp/rules/imp/luau")
return {
    analyzer = luau.luau_analyzer_toolchain("0.709", { lockfile = "@workspace/luau-analyze.lock" }),
}
"""


def assert_workspace_files(root, expected):
    """Actions write only into their sandboxes, not into the workspace."""
    found = sorted(path.name for path in root.iterdir())
    assert found == sorted(expected), found


def check_local_lockfile(binary, env):
    with tempfile.TemporaryDirectory(prefix="imp-lockfiles-consumer-") as directory:
        root = Path(directory)
        artifact = b"local lockfile consumer artifact\n"
        (root / "artifact").write_bytes(artifact)
        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=root
        )
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/artifact"
            (root / "imp.workspace.luau").write_text(
                """local core = require("@imp/core")
local lockfiles = require("@imp/rules/workflows/lockfiles")
local spec = {
    name = "local", versions = { "2.0.0" },
    lockfile = "@workspace/local.lock",
    platforms = { { os = "linux", arch = "x86_64" } },
    download_url = function() return URL end,
    artifact_name = function() return "artifact" end,
}
lockfiles.register_builtin_lockfile(spec)
core.goal("local-lockfiles", lockfiles.graph_gen_lockfiles_goal, {
    selection = "none",
    roots = function()
        local roots = {}
        for _, item in ipairs(lockfiles.builtin_lockfiles()) do
            table.insert(roots, { address = item.lockfile, root = lockfiles.generate_builtin_lockfile(item) })
        end
        return roots
    end,
})
return {}
""".replace("URL", json.dumps(url))
            )
            destination = root / "local.lock"
            destination.write_text('{"tool":"local","versions":{"stale":{}}}\n')

            def run(success):
                result = subprocess.run(
                    [str(binary), "goal", "local-lockfiles"],
                    cwd=root,
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=120,
                    check=False,
                )
                print(result.stdout + result.stderr)
                assert (result.returncode == 0) == success, result.returncode

            workspace_files = ["imp.workspace.luau", "local.lock", "artifact"]
            run(True)
            before = destination.read_bytes()
            entry = {
                "url": url,
                "artifact": "artifact",
                "size": len(artifact),
                "sha256": hashlib.sha256(artifact).hexdigest(),
            }
            expected = {"tool": "local", "versions": {"2.0.0": {"linux/x86_64": entry}}}
            assert before == (json.dumps(expected, indent=2) + "\n").encode(), before
            assert_workspace_files(root, workspace_files)
            run(True)
            assert destination.read_bytes() == before
            (root / "artifact").unlink()
            run(False)
            # A failed goal does not publish, so the workspace file stays.
            assert destination.read_bytes() == before
            assert_workspace_files(root, workspace_files[:2])
            print("Lockfile consumer check passed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


def check_real_lockfile(binary, env):
    with tempfile.TemporaryDirectory(prefix="imp-lockfiles-real-") as directory:
        root = Path(directory)
        (root / "imp.workspace.luau").write_text(ANALYZER_WORKSPACE)
        result = subprocess.run(
            [str(binary), "gen-lockfiles", "//:analyzer"],
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            timeout=600,
            check=False,
        )
        print(result.stdout + result.stderr)
        assert result.returncode == 0, result.returncode
        assert_workspace_files(root, ["imp.workspace.luau", "luau-analyze.lock"])
        assert filecmp.cmp(
            root / "luau-analyze.lock", SHIPPED_ANALYZER_LOCK, shallow=False
        ), "the regenerated luau-analyze lockfile differs from the shipped lockfile"
        print("Real lockfile check passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    parser.add_argument(
        "--real-lockfile",
        action="store_true",
        help="also regenerate the shipped luau-analyze lockfile from its downloads",
    )
    args = parser.parse_args()
    binary = args.imp.resolve()
    env = os.environ.copy()
    check_local_lockfile(binary, env)
    if args.real_lockfile:
        check_real_lockfile(binary, env)


if __name__ == "__main__":
    main()
