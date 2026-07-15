use crate::proto::execution_server::ExecutionServer;
use crate::server::ExecutionServer as Service;
use anyhow::{bail, Context, Result};
use std::net::SocketAddr;
use tonic::transport::Server;
use imp_execution::service::LocalExecutionService;

const DEFAULT_DAEMON_ADDR: &str = "127.0.0.1:49671";

pub fn address() -> Result<SocketAddr> {
    let value =
        std::env::var("IMP_DAEMON_ADDR").unwrap_or_else(|_| DEFAULT_DAEMON_ADDR.to_owned());
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
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let service = Service {
        service: std::sync::Arc::new(LocalExecutionService::new()),
        shutdown: shutdown.clone(),
    };
    Server::builder()
        .add_service(ExecutionServer::new(service))
        .serve_with_shutdown(address()?, shutdown.notified())
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
