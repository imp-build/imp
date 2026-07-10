pub mod proto {
    tonic::include_proto!("imp.exec.v1");
}
pub mod client;
pub mod convert;
pub mod lifecycle;
pub mod server;

pub const PROTOCOL_VERSION: u32 = 1;
pub const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
