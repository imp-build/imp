use std::path::PathBuf;
use anyhow::Result;
use tokio::net::UnixListener;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::Server;
use crate::proto::execution_server::ExecutionServer;
use crate::server::ExecutionServer as Service;
use imp_execution::service::LocalExecutionService;

pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("IMP_DAEMON_SOCKET") { return path.into(); }
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") { return PathBuf::from(runtime).join("imp/daemon.sock"); }
    PathBuf::from(format!("/tmp/imp-{}/daemon.sock", std::env::var("UID").unwrap_or_else(|_| "0".to_owned())))
}

pub fn status() -> bool { socket_path().exists() }

pub async fn serve() -> Result<()> {
    #[cfg(not(unix))]
    anyhow::bail!("daemon mode requires Unix sockets");
    #[cfg(unix)]
    {
        let socket = socket_path();
        if let Some(parent) = socket.parent() { std::fs::create_dir_all(parent)?; }
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        let incoming = UnixListenerStream::new(listener);
        let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
        let service = Service { service: std::sync::Arc::new(LocalExecutionService::new()), shutdown: shutdown.clone() };
        Server::builder().add_service(ExecutionServer::new(service)).serve_with_incoming_shutdown(incoming, shutdown.notified()).await?;
    }
    Ok(())
}
