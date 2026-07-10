use std::sync::Arc;
use tokio_stream::{wrappers::ReceiverStream, Stream};
use tonic::{Request, Response, Status};
use imp_exec_api::ExecutionService;
use imp_execution::service::LocalExecutionService;

use crate::{convert, proto, BUILD_VERSION, PROTOCOL_VERSION};

pub struct ExecutionServer {
    pub service: Arc<LocalExecutionService>,
    pub shutdown: Arc<tokio::sync::Notify>,
}

#[tonic::async_trait]
impl proto::execution_server::Execution for ExecutionServer {
    type ExecuteStream =
        std::pin::Pin<Box<dyn Stream<Item = Result<proto::ExecuteEvent, Status>> + Send>>;
    async fn execute(
        &self,
        request: Request<proto::ExecuteRequest>,
    ) -> Result<Response<Self::ExecuteStream>, Status> {
        let req = request.into_inner();
        let action = convert::action_from_proto(
            req.action
                .ok_or_else(|| Status::invalid_argument("missing action"))?,
        )
        .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let svc = Arc::clone(&self.service);
        let (tx, rx) = tokio::sync::mpsc::channel(2);
        tokio::task::spawn_blocking(move || {
            let display = action.display.clone();
            let started = || {
                let _ = tx.blocking_send(Ok(proto::ExecuteEvent {
                    event: Some(proto::execute_event::Event::Started(proto::Started {
                        display: display.clone(),
                    })),
                }));
            };
            let result = svc.execute_with_start(&req.workspace_id, action, None, &started);
            let event = match result {
                Ok(o) => proto::ExecuteEvent {
                    event: Some(proto::execute_event::Event::Finished(proto::Finished {
                        result: Some(proto::finished::Result::Outcome(convert::outcome_to_proto(
                            o,
                        ))),
                    })),
                },
                Err(e) => proto::ExecuteEvent {
                    event: Some(proto::execute_event::Event::Finished(proto::Finished {
                        result: Some(proto::finished::Result::Failure(proto::Failure {
                            message: format!("{e:#}"),
                        })),
                    })),
                },
            };
            let _ = tx.blocking_send(Ok(event));
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
    async fn cache_dir_get(
        &self,
        r: Request<proto::CacheDirRequest>,
    ) -> Result<Response<proto::CacheDirResponse>, Status> {
        let x = r.into_inner();
        let path = self
            .service
            .cache_dir_get(&x.workspace_id, &x.name, &x.key)
            .map_err(err)?;
        Ok(Response::new(proto::CacheDirResponse {
            present: path.is_some(),
            path: path
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }))
    }
    async fn cache_dir_has(
        &self,
        r: Request<proto::CacheDirRequest>,
    ) -> Result<Response<proto::CacheDirResponse>, Status> {
        let x = r.into_inner();
        Ok(Response::new(proto::CacheDirResponse {
            present: self
                .service
                .cache_dir_has(&x.workspace_id, &x.name, &x.key)
                .map_err(err)?,
            path: String::new(),
        }))
    }
    async fn cache_dir_put(
        &self,
        r: Request<proto::CacheDirRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let x = r.into_inner();
        self.service
            .cache_dir_put(
                &x.workspace_id,
                &x.name,
                &x.key,
                &std::path::PathBuf::from(x.source),
            )
            .map_err(err)?;
        Ok(Response::new(proto::Empty {}))
    }
    async fn fetch_url(
        &self,
        r: Request<proto::FetchRequest>,
    ) -> Result<Response<proto::PathResponse>, Status> {
        Ok(Response::new(proto::PathResponse {
            path: self
                .service
                .fetch_url(&r.into_inner().url)
                .map_err(err)?
                .to_string_lossy()
                .into_owned(),
        }))
    }
    async fn extract_archive(
        &self,
        r: Request<proto::ExtractRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let x = r.into_inner();
        self.service
            .extract_archive(
                &std::path::PathBuf::from(x.archive),
                &std::path::PathBuf::from(x.dest),
                &x.format,
                x.strip_components,
            )
            .map_err(err)?;
        Ok(Response::new(proto::Empty {}))
    }
    async fn file_sha256(
        &self,
        r: Request<proto::FileRequest>,
    ) -> Result<Response<proto::FileResponse>, Status> {
        let x = r.into_inner();
        Ok(Response::new(proto::FileResponse {
            digest: self
                .service
                .file_sha256(&std::path::PathBuf::from(x.path))
                .map_err(err)?,
        }))
    }
    async fn register_native_tool(
        &self,
        r: Request<proto::NativeToolRequest>,
    ) -> Result<Response<proto::PathResponse>, Status> {
        let x = r.into_inner();
        Ok(Response::new(proto::PathResponse {
            path: self
                .service
                .register_native_tool(&x.name, &std::path::PathBuf::from(x.path))
                .map_err(err)?
                .to_string_lossy()
                .into_owned(),
        }))
    }
    async fn worker_start(
        &self,
        r: Request<proto::WorkerRequest>,
    ) -> Result<Response<proto::WorkerResponse>, Status> {
        let x = r.into_inner();
        let env: Vec<(String, String)> = x
            .env
            .into_iter()
            .filter_map(|e| e.split_once('=').map(|(a, b)| (a.to_owned(), b.to_owned())))
            .collect();
        let h = self
            .service
            .worker_start(
                &x.workspace_id,
                &x.name,
                imp_exec_api::WorkerSpec {
                    argv: x.argv,
                    env,
                    health_check_argv: x.health_check_argv,
                },
            )
            .await
            .map_err(err)?;
        Ok(Response::new(proto::WorkerResponse {
            home_dir: h.home_dir.to_string_lossy().into_owned(),
            tmp_dir: h.tmp_dir.to_string_lossy().into_owned(),
            port: h.port as u32,
            present: true,
        }))
    }
    async fn worker_get(
        &self,
        r: Request<proto::WorkerRequest>,
    ) -> Result<Response<proto::WorkerResponse>, Status> {
        let h = self.service.worker_get(&r.into_inner().name).map_err(err)?;
        Ok(Response::new(
            h.map(|h| proto::WorkerResponse {
                home_dir: h.home_dir.to_string_lossy().into_owned(),
                tmp_dir: h.tmp_dir.to_string_lossy().into_owned(),
                port: h.port as u32,
                present: true,
            })
            .unwrap_or(proto::WorkerResponse {
                home_dir: String::new(),
                tmp_dir: String::new(),
                port: 0,
                present: false,
            }),
        ))
    }
    async fn get_capabilities(
        &self,
        _: Request<proto::Empty>,
    ) -> Result<Response<proto::Capabilities>, Status> {
        let c = self.service.capabilities().map_err(err)?;
        Ok(Response::new(proto::Capabilities {
            protocol_version: PROTOCOL_VERSION,
            build_version: BUILD_VERSION.to_owned(),
            exe_fingerprint: String::new(),
            pid: std::process::id(),
            os: c.os.to_owned(),
            arch: c.arch.to_owned(),
        }))
    }
    async fn shutdown(&self, _: Request<proto::Empty>) -> Result<Response<proto::Empty>, Status> {
        self.shutdown.notify_waiters();
        Ok(Response::new(proto::Empty {}))
    }
}
fn err(e: anyhow::Error) -> Status {
    Status::internal(format!("{e:#}"))
}
