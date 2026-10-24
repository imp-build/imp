"""Check selectorless Luau lockfile generation with a local artifact."""
import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    binary = parser.parse_args().imp.resolve()
    env = {**os.environ, "IMP_RUNTIME": "luau"}
    with tempfile.TemporaryDirectory(prefix="imp-lockfiles-consumer-") as directory:
        root = Path(directory)
        artifact = b"local lockfile consumer artifact\n"
        (root / "artifact").write_bytes(artifact)
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/artifact"
            (root / "imp.workspace.luau").write_text('''local core = require("@imp/core")
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
'''.replace("URL", json.dumps(url)))
            destination = root / "local.lock"
            destination.write_text('{"tool":"local","versions":{"stale":{}}}\n')

            def run(success):
                result = subprocess.run([str(binary), "goal", "local-lockfiles"],
                                        cwd=root, env=env, text=True,
                                        capture_output=True, timeout=120)
                print(result.stdout + result.stderr)
                assert (result.returncode == 0) == success, result.returncode

            run(True)
            before = destination.read_bytes()
            lock = json.loads(before)
            assert list(lock["versions"]) == ["2.0.0"]
            entry = lock["versions"]["2.0.0"]["linux/x86_64"]
            assert entry == {"url": url, "artifact": "artifact", "size": len(artifact),
                             "sha256": hashlib.sha256(artifact).hexdigest()}
            run(True)
            assert destination.read_bytes() == before
            (root / "artifact").unlink()
            run(False)
            assert destination.read_bytes() == before
            print("Lockfile consumer check passed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    main()
