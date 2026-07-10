use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use anyhow::{bail, Result};
use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;
use tower::service_fn;
use hyper_util::rt::TokioIo;
use imp_exec_api::{Capabilities, ExecAction, ExecOutcome, ExecutionService, WorkerHandle, WorkerSpec};
use crate::{convert, lifecycle, proto};

pub struct RemoteExecutionService { rt: Option<tokio::runtime::Runtime> }

impl RemoteExecutionService {
    pub fn connect() -> Result<Self> {
        if !cfg!(unix) { bail!("daemon mode requires Unix sockets"); }
        // `connect` is part of a synchronous factory but is called while the
        // frontend runtime is loading QuickJS. Construct and drive the
        // blocking-capable client runtime on a plain OS thread so this never
        // nests Tokio runtimes.
        std::thread::spawn(|| -> Result<Self> {
            let rt=tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build()?;
            let service=Self{rt:Some(rt)};
            if service.rt.as_ref().unwrap().block_on(service.channel()).is_err() {
                let exe = std::env::current_exe()?;
                let mut command = std::process::Command::new(exe);
                command.args(["daemon", "serve"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                #[cfg(unix)] {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                let _ = command.spawn();
                let mut connected = false;
                for _ in 0..50 {
                    if service.rt.as_ref().unwrap().block_on(service.channel()).is_ok() { connected = true; break; }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                if !connected { bail!("could not connect to imp daemon; try `imp daemon stop`"); }
            }
            Ok(service)
        }).join().map_err(|_| anyhow::anyhow!("daemon client initialization thread panicked"))?
    }
    async fn channel(&self) -> Result<Channel> {
        let path=lifecycle::socket_path();
        let endpoint=Endpoint::try_from("http://[::]:50051")?;
        Ok(endpoint.connect_with_connector(service_fn(move |_:tonic::codegen::http::Uri| { let path=path.clone(); async move { Ok::<_, std::io::Error>(TokioIo::new(UnixStream::connect(path).await?)) } } )).await?)
    }
    fn block_on_external<T: Send>(&self, f: impl FnOnce(&tokio::runtime::Runtime) -> Result<T> + Send) -> Result<T> {
        if tokio::runtime::Handle::try_current().is_ok() {
            std::thread::scope(|scope| scope.spawn(|| f(self.rt.as_ref().unwrap())).join().map_err(|_| anyhow::anyhow!("daemon runtime thread panicked"))?)
        } else { f(self.rt.as_ref().unwrap()) }
    }
    fn client(&self) -> Result<proto::execution_client::ExecutionClient<Channel>> { self.block_on_external(|rt| Ok(rt.block_on(self.channel()).map(proto::execution_client::ExecutionClient::new)?)) }

    pub fn shutdown_existing() -> Result<()> {
        let rt=tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let path=lifecycle::socket_path();
        rt.block_on(async move {
            let endpoint=Endpoint::try_from("http://[::]:50051")?;
            let channel=endpoint.connect_with_connector(service_fn(move |_:tonic::codegen::http::Uri| { let path=path.clone(); async move { Ok::<_, std::io::Error>(TokioIo::new(UnixStream::connect(path).await?)) } })).await?;
            let mut client=proto::execution_client::ExecutionClient::new(channel);
            client.shutdown(Request::new(proto::Empty{})).await?;
            Ok::<(), anyhow::Error>(())
        })
    }
}

impl Drop for RemoteExecutionService {
    fn drop(&mut self) {
        let Some(rt) = self.rt.take() else { return };
        if tokio::runtime::Handle::try_current().is_ok() {
            let _ = std::thread::Builder::new()
                .name("imp-daemon-runtime-shutdown".to_owned())
                .spawn(move || drop(rt));
        } else {
            drop(rt);
        }
    }
}

#[async_trait::async_trait]
impl ExecutionService for RemoteExecutionService {
    fn execute(&self, workspace_id:&str, action:ExecAction, _cancellation:Option<&AtomicBool>)->Result<ExecOutcome>{
        self.execute_with_start(workspace_id, action, _cancellation, &|| {})
    }
    fn execute_with_start(&self, workspace_id:&str, action:ExecAction, _cancellation:Option<&AtomicBool>, started:&dyn Fn())->Result<ExecOutcome>{
        let mut c=self.client()?; let req=proto::ExecuteRequest{workspace_id:workspace_id.to_owned(),action:Some(convert::action_to_proto(action))}; let mut stream=self.block_on_external(|rt| Ok(rt.block_on(c.execute(Request::new(req)))?.into_inner()))?;
        loop { match self.block_on_external(|rt| Ok(rt.block_on(stream.message())?))? { Some(e)=>match e.event { Some(proto::execute_event::Event::Started(_))=>started(), Some(proto::execute_event::Event::Finished(f))=>return match f.result { Some(proto::finished::Result::Outcome(o))=>Ok(convert::outcome_from_proto(o)), Some(proto::finished::Result::Failure(f))=>bail!("{}",f.message), None=>bail!("daemon returned empty result") }, None=>{} }, None=>bail!("daemon closed execution stream") } }
    }
    fn cache_dir_get(&self,w:&str,n:&str,k:&str)->Result<Option<PathBuf>>{let mut c=self.client()?;let x=self.block_on_external(|rt| Ok(rt.block_on(c.cache_dir_get(Request::new(proto::CacheDirRequest{workspace_id:w.into(),name:n.into(),key:k.into(),source:String::new()})))?.into_inner()))?;Ok(if x.present{Some(x.path.into())}else{None})}
    fn cache_dir_has(&self,w:&str,n:&str,k:&str)->Result<bool>{let mut c=self.client()?;Ok(self.block_on_external(|rt| Ok(rt.block_on(c.cache_dir_has(Request::new(proto::CacheDirRequest{workspace_id:w.into(),name:n.into(),key:k.into(),source:String::new()})))?.into_inner().present))?)}
    fn cache_dir_put(&self,w:&str,n:&str,k:&str,s:&Path)->Result<()> {let mut c=self.client()?;self.block_on_external(|rt| { rt.block_on(c.cache_dir_put(Request::new(proto::CacheDirRequest{workspace_id:w.into(),name:n.into(),key:k.into(),source:s.to_string_lossy().into_owned()})))?; Ok(()) })?;Ok(())}
    fn fetch_url(&self,u:&str)->Result<PathBuf>{let mut c=self.client()?;Ok(self.block_on_external(|rt| Ok(rt.block_on(c.fetch_url(Request::new(proto::FetchRequest{url:u.into()})))?.into_inner().path.into()))?)}
    fn extract_archive(&self,a:&Path,d:&Path,f:&str,s:u32)->Result<()> {let mut c=self.client()?;self.block_on_external(|rt| { rt.block_on(c.extract_archive(Request::new(proto::ExtractRequest{archive:a.to_string_lossy().into_owned(),dest:d.to_string_lossy().into_owned(),format:f.into(),strip_components:s})))?; Ok(()) })?;Ok(())}
    fn file_sha256(&self,p:&Path)->Result<String>{let mut c=self.client()?;Ok(self.block_on_external(|rt| Ok(rt.block_on(c.file_sha256(Request::new(proto::FileRequest{path:p.to_string_lossy().into_owned()})))?.into_inner().digest))?)}
    fn register_native_tool(&self,n:&str,p:&Path)->Result<PathBuf>{let mut c=self.client()?;Ok(self.block_on_external(|rt| Ok(rt.block_on(c.register_native_tool(Request::new(proto::NativeToolRequest{name:n.into(),path:p.to_string_lossy().into_owned()})))?.into_inner().path.into()))?)}
    async fn worker_start(&self,w:&str,n:&str,s:WorkerSpec)->Result<WorkerHandle>{let channel=self.channel().await?;let mut c=proto::execution_client::ExecutionClient::new(channel);let x=c.worker_start(Request::new(proto::WorkerRequest{workspace_id:w.into(),name:n.into(),argv:s.argv,env:s.env.into_iter().map(|(a,b)|format!("{a}={b}")).collect(),health_check_argv:s.health_check_argv})).await?.into_inner();Ok(WorkerHandle{home_dir:x.home_dir.into(),tmp_dir:x.tmp_dir.into(),port:x.port as u16})}
    fn worker_get(&self,n:&str)->Result<Option<WorkerHandle>>{let mut c=self.client()?;let x=self.block_on_external(|rt| Ok(rt.block_on(c.worker_get(Request::new(proto::WorkerRequest{name:n.into(),..Default::default()})))?.into_inner()))?;Ok(x.present.then(||WorkerHandle{home_dir:x.home_dir.into(),tmp_dir:x.tmp_dir.into(),port:x.port as u16}))}
    fn capabilities(&self)->Result<Capabilities>{let mut c=self.client()?;let x=self.block_on_external(|rt| Ok(rt.block_on(c.get_capabilities(Request::new(proto::Empty{})))?.into_inner()))?;Ok(Capabilities{os:Box::leak(x.os.into_boxed_str()),arch:Box::leak(x.arch.into_boxed_str())})}
}
