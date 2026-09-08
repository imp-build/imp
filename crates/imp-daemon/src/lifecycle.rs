use crate::proto::execution_server::ExecutionServer;
use crate::server::ExecutionServer as Service;
use anyhow::{bail, Context, Result};
use imp_execution::service::LocalExecutionService;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;

const DEFAULT_DAEMON_ADDR: &str = "127.0.0.1:49671";

pub fn address() -> Result<SocketAddr> {
    let value = std::env::var("IMP_DAEMON_ADDR").unwrap_or_else(|_| DEFAULT_DAEMON_ADDR.to_owned());
    parse_address(&value)
}

fn parse_address(value: &str) -> Result<SocketAddr> {
    let address: SocketAddr = value
        .parse()
        .with_context(|| format!("invalid IMP_DAEMON_ADDR {value:?}"))?;
    if !address.ip().is_loopback() {
        bail!("IMP_DAEMON_ADDR must use a loopback address");
    }
    Ok(address)
}

pub fn endpoint_uri() -> Result<String> {
    Ok(format!("http://{}", address()?))
}

pub async fn serve() -> Result<()> {
    let shutdown = Arc::new(Notify::new());
    let service = Service {
        service: Arc::new(LocalExecutionService::new()),
        shutdown: shutdown.clone(),
        protocol_version: crate::PROTOCOL_VERSION,
    };
    let addr = address()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind imp daemon on {addr}"))?;
    serve_on(listener, service, shutdown).await
}

/// Serve the execution API over an already-bound loopback listener until
/// `shutdown` is notified. `serve()` is the production wrapper; a test binds
/// `127.0.0.1:0` itself so it never contends for the default port or a
/// daemon another process is already running.
pub async fn serve_on(
    listener: TcpListener,
    service: Service,
    shutdown: Arc<Notify>,
) -> Result<()> {
    Server::builder()
        .add_service(ExecutionServer::new(service))
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), shutdown.notified())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_address;

    #[test]
    fn daemon_address_must_be_loopback() {
        assert_eq!(
            parse_address("127.0.0.1:1234").unwrap().to_string(),
            "127.0.0.1:1234"
        );
        assert_eq!(
            parse_address("[::1]:1234").unwrap().to_string(),
            "[::1]:1234"
        );
        assert!(parse_address("0.0.0.0:1234").is_err());
        assert!(parse_address("not-an-address").is_err());
    }
}
