fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown-target".to_owned());
    println!(
        "cargo:rustc-env=IMP_DAEMON_BUILD_FINGERPRINT=imp-daemon/{}/{}",
        env!("CARGO_PKG_VERSION"),
        target
    );
    let fds = protox::compile(["proto/imp_exec_v1.proto"], ["proto"])?;
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_fds(fds)?;
    println!("cargo:rerun-if-changed=proto/imp_exec_v1.proto");
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
