use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

fn workspace_with_run(script: &str) -> TempDir {
    let root = tempfile::tempdir().expect("create temporary workspace");
    write_run_target(&root, script);
    root
}

fn write_run_target(root: &TempDir, script: &str) {
    std::fs::write(root.path().join("imp.workspace.js"), "").expect("write workspace marker");

    let script = serde_json::to_string(script).expect("encode shell script as JavaScript string");
    let build = format!(
        r#"
import {{ label, run, runGoal }} from "imp:core";

const probe = label();
runGoal(probe, async function runOutputProbe() {{
    return run({{
        argv: ["sh", "-c", {script}],
        display: "run output probe",
        sandbox: true,
        impure: true,
        workspaceCwd: true,
        stream: true,
    }});
}});

export {{ probe }};
"#
    );
    std::fs::write(root.path().join("BUILD.js"), build).expect("write run target");
}

fn imp_run(root: &std::path::Path) -> Option<Command> {
    let imp_binary = std::path::Path::new(env!("CARGO_BIN_EXE_imp"));
    // Imp runs Rust test binaries in an isolated sandbox. Its Cargo test
    // action stages the test binaries, but not this separate CLI binary.
    // Direct `cargo test` runs this CLI regression with the binary present.
    if !imp_binary.is_file() {
        eprintln!("skip CLI output check: cargo did not stage the imp binary");
        return None;
    }

    let mut command = Command::new(imp_binary);
    command
        .current_dir(root)
        .arg("run")
        .arg("//:probe")
        .env("XDG_CACHE_HOME", std::env::temp_dir().join("imp"))
        .env(
            "IMP_RULES_DIR",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(std::path::Path::parent)
                .expect("find repository root")
                .join("rules"),
        );
    Some(command)
}

fn assert_lines_in_order(output: &str) {
    let first = output
        .find("progress line one\n")
        .expect("first flushed line reaches imp stdout");
    let second = output
        .find("progress line two\n")
        .expect("second flushed line reaches imp stdout");
    assert!(first < second, "child output order changed: {output:?}");
}

#[test]
fn run_preserves_flushed_output_when_child_exits_nonzero() {
    let root =
        workspace_with_run("printf 'progress line one\\n'; printf 'progress line two\\n'; exit 7");
    let Some(mut command) = imp_run(root.path()) else {
        return;
    };
    let output = command
        .output()
        .expect("run imp against temporary workspace");
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(!output.status.success(), "a failed child must fail imp run");
    assert_lines_in_order(&stdout);
}

#[cfg(unix)]
fn assert_interrupted_output_is_preserved(signal_imp: bool) {
    let workspace = tempfile::tempdir().expect("create temporary workspace");
    let pid_file = workspace.path().join("child.pid");
    let script = format!(
        "printf 'progress line one\\n'; printf 'progress line two\\n'; printf '%s\\n' \"$$\" > '{}'; exec sleep 60",
        pid_file.display()
    );
    write_run_target(&workspace, &script);
    let Some(mut command) = imp_run(workspace.path()) else {
        return;
    };
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut imp = command.spawn().expect("start imp run");

    let stdout = imp.stdout.take().expect("capture imp stdout");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr = imp.stderr.take().expect("capture imp stderr");
    let stderr_reader = thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + Duration::from_secs(10);
    let child_pid = loop {
        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            break pid.trim().parse::<u32>().expect("parse child pid");
        }
        if let Some(status) = imp.try_wait().expect("poll imp") {
            panic!("imp exited before the child started: {status}");
        }
        assert!(Instant::now() < deadline, "child did not start in time");
        thread::sleep(Duration::from_millis(10));
    };

    let target_pid = if signal_imp { imp.id() } else { child_pid };
    let signal_status = Command::new("kill")
        .args(["-INT", &target_pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(
        signal_status.success(),
        "kill could not signal pid {target_pid}"
    );

    let status = wait_with_timeout(&mut imp, deadline + Duration::from_secs(10));
    assert!(!status.success(), "interrupted run must fail");

    let stdout = String::from_utf8(stdout_reader.join().expect("join stdout reader"))
        .expect("stdout is valid UTF-8");
    let _stderr = stderr_reader.join().expect("join stderr reader");
    assert_lines_in_order(&stdout);
}

#[cfg(unix)]
fn read_all(mut reader: impl Read) -> Vec<u8> {
    let mut output = Vec::new();
    reader.read_to_end(&mut output).expect("read child output");
    output
}

#[cfg(unix)]
fn wait_with_timeout(child: &mut Child, deadline: Instant) -> ExitStatus {
    loop {
        if let Some(status) = child.try_wait().expect("poll imp after SIGINT") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("imp did not exit after SIGINT");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
fn run_preserves_flushed_output_when_imp_is_interrupted() {
    assert_interrupted_output_is_preserved(true);
}

#[cfg(unix)]
#[test]
fn run_preserves_flushed_output_when_child_is_interrupted() {
    assert_interrupted_output_is_preserved(false);
}
