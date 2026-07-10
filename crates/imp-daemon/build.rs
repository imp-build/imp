fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fds = protox::compile(["proto/imp_exec_v1.proto"], ["proto"])?;
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_fds(fds)?;
    println!("cargo:rerun-if-changed=proto/imp_exec_v1.proto");
    Ok(())
}
