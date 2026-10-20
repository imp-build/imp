"""Check Luau OCI layouts and archives with real sandboxed actions."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

WORKSPACE = '''require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
return {}
'''
BUILD = '''local oci = require("@imp/rules/oci")
local crane = require("@imp/rules/oci/toolchain")
local core = require("@imp/core")
local base = oci.oci_build({
    base = "scratch",
    path = "data[1]",
    layers = {
        { srcs = { "bin/*" }, exclude = { "bin/excluded" }, path = "/usr/local/bin", mode = "0755", uid = 123, gid = 456 },
        { srcs = { "config/*" }, path = "/etc", mode = "0640" },
    },
    entrypoint = "/usr/local/bin/bin/server",
    cmd = { "serve", "two words" },
    env = { Z = "last", A = "first" },
    labels = { z = "é", a = "quote\\\" and slash\\\\ and newline\\n" },
    user = "123:456", workdir = "/srv",
})
local derived = oci.oci_build({
    base = base,
    path = "data[1]",
    layers = { { srcs = { "extra/*" }, path = "/opt", mode = "0644" } },
    labels = { added = "yes" },
})
local version = core.task({
    inputs = { crane = crane.graph_toolchain().tool },
    outputs = { version = core.output.value() },
    run = function(exec, inputs)
        local result = exec.action({ argv = { crane.crane_bin(exec, inputs.crane), "version" } })
        assert(string.find(result.stdout, "0.22.1", 1, true), result.stdout)
        return { version = result.stdout }
    end,
})
return { base = base, derived = derived, crane_version = { BUILD = version } }
'''


def inspect_archive(path, expected_layers, extra=b"extra\n"):
    archive_bytes = path.read_bytes()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        files = {
            member.name.removeprefix("./"): archive.extractfile(member).read()
            for member in archive.getmembers() if member.isfile()
        }
        assert all(member.mtime == 0 and member.uid == 0 and member.gid == 0 for member in archive.getmembers())
    assert json.loads(files["oci-layout"]) == {"imageLayoutVersion": "1.0.0"}
    index = json.loads(files["index.json"])
    assert len(index["manifests"]) == 1
    descriptor = index["manifests"][0]
    assert descriptor["platform"] == {"architecture": "amd64", "os": "linux"}

    def blob(descriptor):
        data = files["blobs/sha256/" + descriptor["digest"].removeprefix("sha256:")]
        assert len(data) == descriptor["size"]
        assert "sha256:" + hashlib.sha256(data).hexdigest() == descriptor["digest"]
        return data

    # Also check retained base blobs which the new manifest no longer names.
    for name, data in files.items():
        if name.startswith("blobs/sha256/"):
            assert hashlib.sha256(data).hexdigest() == name.rsplit("/", 1)[1]
    manifest = json.loads(blob(descriptor))
    config = json.loads(blob(manifest["config"]))
    assert config["architecture"] == "amd64" and config["os"] == "linux"
    assert len(manifest["layers"]) == expected_layers
    assert config["rootfs"]["diff_ids"] == [layer["digest"] for layer in manifest["layers"]]
    assert all(entry["created"] == "1970-01-01T00:00:00Z" for entry in config["history"])
    contents = []
    for layer in manifest["layers"]:
        with tarfile.open(fileobj=io.BytesIO(blob(layer))) as tar:
            assert all(member.mtime == 0 for member in tar.getmembers())
            contents.append({member.name.removeprefix("./"): (tar.extractfile(member).read(), member.mode, member.uid, member.gid)
                             for member in tar.getmembers() if member.isfile()})
    assert contents[0] == {"usr/local/bin/bin/server": (b"server\n", 0o755, 123, 456)}
    assert contents[1] == {"etc/config/settings": (b"setting=true\n", 0o640, 0, 0)}
    metadata = config["config"]
    assert metadata["Entrypoint"] == ["/usr/local/bin/bin/server"]
    assert metadata["Cmd"] == ["serve", "two words"]
    assert metadata["Env"] == ["A=first", "Z=last"]
    assert metadata["User"] == "123:456" and metadata["WorkingDir"] == "/srv"
    assert metadata["Labels"]["a"] == 'quote" and slash\\ and newline\n'
    assert metadata["Labels"]["z"] == "é"
    if expected_layers == 3:
        assert contents[2] == {"opt/extra/value": (extra, 0o644, 0, 0)}
        assert metadata["Labels"]["added"] == "yes"
    return descriptor["digest"], archive_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imp", type=Path, required=True)
    args = parser.parse_args()
    binary = args.imp.resolve()
    rules = Path(__file__).resolve().parents[2]
    env = {**os.environ, "IMP_RUNTIME": "luau", "IMP_RULES_DIR": str(rules)}
    snapshots = []
    for _ in range(2):
        with tempfile.TemporaryDirectory(prefix="imp-oci-consumer-") as directory:
            root = Path(directory)
            (root / "imp.workspace.luau").write_text(WORKSPACE)
            (root / "images").mkdir()
            (root / "images/BUILD.luau").write_text(BUILD)
            for name, content in {"bin/server": "server\n", "bin/excluded": "exclude me\n", "config/settings": "setting=true\n", "extra/value": "extra\n"}.items():
                target = root / "images/data[1]" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)

            def run(*arguments, failure=False):
                command = [str(binary), arguments[0], "--no-cache", *arguments[1:]]
                result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
                print("$ " + " ".join(command), flush=True)
                print(result.stdout + result.stderr, flush=True)
                assert (result.returncode != 0) if failure else (result.returncode == 0), result.returncode
                return result

            run("build", "//images:base", "//images:derived", "//images:crane_version")
            assert not (root / "dist").exists()
            run("package", "//images:base", "//images:derived")
            base = inspect_archive(root / "dist/images/base/image.tar", 2)
            derived = inspect_archive(root / "dist/images/derived/image.tar", 3)
            snapshots.append((base, derived))
            # A leading dash in a root-relative source is a filename, not an option.
            (root / "-hello.txt").write_text("leading dash\n")
            (root / "BUILD.luau").write_text('''local oci = require("@imp/rules/oci")
return { dash = oci.oci_build({
    base = "scratch",
    layers = { { srcs = { "*.txt" }, path = "/app" } },
}) }
''')
            run("package", "//:dash")
            with tarfile.open(root / "dist/dash/image.tar") as archive:
                index = json.load(archive.extractfile("./index.json"))
                manifest = json.load(archive.extractfile("./blobs/sha256/" + index["manifests"][0]["digest"].removeprefix("sha256:")))
                layer = archive.extractfile("./blobs/sha256/" + manifest["layers"][0]["digest"].removeprefix("sha256:")).read()
            with tarfile.open(fileobj=io.BytesIO(layer)) as archive:
                assert archive.extractfile("./app/-hello.txt").read() == b"leading dash\n"
            # An edit must invalidate the image without relying on a warm cache.
            (root / "images/data[1]/extra/value").write_text("changed\n")
            run("package", "//images:derived")
            changed = inspect_archive(root / "dist/images/derived/image.tar", 3, extra=b"changed\n")
            assert changed[0] != derived[0] and changed[1] != derived[1]
            # A failed staging command must fail the goal, before composition.
            (root / "images/BUILD.luau").write_text(BUILD.replace('mode = "0755"', 'mode = "not-a-mode"'))
            failed = run("build", "//images:base", failure=True)
            assert "chmod" in failed.stdout + failed.stderr
            assert not (root / "images/layer-stage-1").exists()
    assert snapshots[0] == snapshots[1], "fresh builds produced different image digests or archives"
    print("Luau OCI consumer check passed: layouts, hashes, metadata, determinism, source edits, and failures")


if __name__ == "__main__":
    main()
