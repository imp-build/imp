use std::path::{Path, PathBuf};
use std::process::Command;

struct Workspace {
    root: tempfile::TempDir,
    rules: PathBuf,
}

impl Workspace {
    fn write(&self, path: &str, contents: &str) {
        let path = self.root.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.path().join(path)).unwrap()
    }

    fn run(&self, args: &[&str], success: bool) -> String {
        let output = Command::new(env!("CARGO_BIN_EXE_imp"))
            .current_dir(self.root.path())
            .env("IMP_RULES_DIR", &self.rules)
            .env_remove("GITHUB_ACTIONS")
            .env_remove("IMP_RUNTIME")
            .args(args)
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.success(), success, "{args:?}: {text}");
        text
    }
}

#[test]
#[ignore = "downloads pinned quality toolchains; run explicitly on Linux x86_64"]
fn real_luau_quality_tools_preserve_workflow_and_cache_contracts() {
    assert!(cfg!(all(target_os = "linux", target_arch = "x86_64")));
    let workspace = Workspace {
        root: tempfile::tempdir().unwrap(),
        rules: Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("rules"),
    };
    let declarations = r#"
local q = require("@imp/rules/imp/luau")
q.stylua_toolchain("2.6.0", { default = true })
q.luau_analyzer_toolchain("0.709", { default = true })
return {}
"#;
    workspace.write("imp.workspace.luau", declarations);
    workspace.write(
        "BUILD.luau",
        r#"
local q = require("@imp/rules/imp/luau")
return {
    source = q.luau_sources({ base = "pkg", srcs = { "*.luau" }, exclude = { "ignored.luau" } }),
    empty = q.luau_sources({ srcs = { "missing/*.luau" } }),
}
"#,
    );
    workspace.write(".luaurc", r#"{"languageMode":"nocheck","lintErrors":true}"#);
    workspace.write(".stylua.toml", "indent_type = \"Tabs\"\n");
    workspace.write("pkg/ignored.luau", "invalid source !");
    let original = "local value={a=1,b=2}\nreturn value\n";
    workspace.write("pkg/source.luau", original);
    workspace.run(&["fmt", "//:source", "--check"], false);
    assert_eq!(workspace.read("pkg/source.luau"), original);
    workspace.run(&["fmt", "//:source"], true);
    let formatted = workspace.read("pkg/source.luau");
    assert_ne!(formatted, original);
    workspace.run(&["fmt", "//:source", "--check"], true);
    workspace.run(&["fmt", "//:source"], true);
    assert_eq!(workspace.read("pkg/source.luau"), formatted);
    workspace.run(&["lint", "//:source"], true);
    workspace.run(&["lint", "//:source", "--fix"], true);
    assert_eq!(workspace.read("pkg/source.luau"), formatted);
    workspace.run(&["fmt", "//:empty", "--check"], true);
    workspace.run(&["lint", "//:empty"], true);

    workspace.write("pkg/source.luau", "return \"text\"\n");
    workspace.write(".stylua.toml", "quote_style = \"ForceSingle\"\n");
    workspace.run(&["fmt", "//:source"], true);
    assert_eq!(workspace.read("pkg/source.luau"), "return 'text'\n");
    workspace.write(".stylua.toml", "quote_style = \"ForceDouble\"\n");
    workspace.run(&["fmt", "//:source", "--check"], false);
    workspace.run(&["fmt", "//:source"], true);
    assert_eq!(workspace.read("pkg/source.luau"), "return \"text\"\n");

    workspace.write("pkg/source.luau", "return nonexistent_global\n");
    let text = workspace.run(&["lint", "//:source"], false);
    assert!(text.contains("UnknownGlobal") && text.contains("pkg/source.luau:"));
    workspace.write(
        ".luaurc",
        r#"{"languageMode":"nocheck","lintErrors":true,"globals":["nonexistent_global"]}"#,
    );
    workspace.run(&["lint", "//:source"], true);
    workspace.write("pkg/source.luau", "local = !\n");
    workspace.run(&["fmt", "//:source", "--check"], false);
    workspace.run(&["fmt", "//:source"], false);
    assert_eq!(workspace.read("pkg/source.luau"), "local = !\n");
    assert!(workspace
        .run(&["lint", "//:source"], false)
        .contains("SyntaxError"));

    workspace.write(
        "imp.workspace.luau",
        &declarations.replace("2.6.0", "99.0.0"),
    );
    let text = workspace.run(&["fmt", "//:source"], false);
    assert!(text.contains("99.0.0") && text.contains("lockfile"));
}

#[test]
#[ignore = "uses native quality-tool acquisition and Python fixtures; run explicitly on Linux x86_64"]
fn custom_locks_for_one_version_select_their_own_archive() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    assert!(cfg!(all(target_os = "linux", target_arch = "x86_64")));
    let workspace = Workspace {
        root: tempfile::tempdir().unwrap(),
        rules: Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("rules"),
    };
    let output = Command::new("python3")
        .arg("-c")
        .arg(r#"
import hashlib, json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
records = []
for value in ['first', 'second']:
    path = root / (value + '.zip')
    entry = zipfile.ZipInfo('stylua')
    entry.create_system = 3
    entry.external_attr = 0o100755 << 16
    script = '#!/bin/sh\nfor path do\ncase "$path" in *.luau) printf \'return "' + value + '"\\n\' > "$path";; esac\ndone\n'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr(entry, script)
    data = path.read_bytes()
    records.append({'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
print(json.dumps(records))
"#)
        .arg(workspace.root.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let records: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let archives: Vec<_> = ["first.zip", "second.zip"]
        .iter()
        .map(|name| std::fs::read(workspace.root.path().join(name)).unwrap())
        .collect();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        // Two distinct archives are downloaded; returning to the first uses CAS.
        for stream in listener.incoming().take(2) {
            let mut stream = stream.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let index = usize::from(request.starts_with("GET /second.zip "));
            let data = &archives[index];
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len()
            )
            .unwrap();
            stream.write_all(data).unwrap();
        }
    });
    let version = format!(
        "cache-regression-{}",
        workspace.root.path().file_name().unwrap().to_string_lossy()
    );
    workspace.write(
        "imp.workspace.luau",
        &format!(
            r#"
local q = require("@imp/rules/imp/luau")
q.stylua_toolchain("{version}", {{ default = true, lockfile = "@workspace/tool.lock" }})
q.luau_analyzer_toolchain("0.709", {{ default = true }})
return {{}}
"#
        ),
    );
    workspace.write("BUILD.luau", "local q = require('@imp/rules/imp/luau')\nreturn { source = q.luau_sources({ srcs = { 'source.luau' } }) }\n");
    for (index, label) in [(0, "first"), (1, "second"), (0, "first")] {
        let mut entry = records[index].clone();
        entry["url"] = format!("http://{address}/{label}.zip").into();
        entry["artifact"] = format!("{label}.zip").into();
        workspace.write(
            "tool.lock",
            &serde_json::json!({
                "tool": "stylua", "versions": { (version.clone()): { "linux/x86_64": entry } }
            })
            .to_string(),
        );
        workspace.write("source.luau", "return 'input'\n");
        workspace.run(&["fmt", "//:source"], true);
        assert_eq!(
            workspace.read("source.luau"),
            format!("return \"{label}\"\n")
        );
    }
    server.join().unwrap();
}
