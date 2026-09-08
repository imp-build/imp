//! End-to-end coverage for the loopback `imp.exec.v1` daemon: lifecycle
//! (bind, protocol check, clean stop), the `Execute` event stream order, and
//! parity between daemon and in-process execution.
//!
//! Every test builds its own [`ExecutionServer`] on `127.0.0.1:0`, so nothing
//! here depends on a daemon already running on the default port. Cache state
//! is isolated with a per-binary throwaway `IMP_CACHE_DIR`, and each action
//! carries a nonce, so a first run is always a cold miss regardless of the
//! developer's real cache.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Mutex, MutexGuard, Once, PoisonError};
use std::time::{Duration, Instant};

use imp_exec_api::{CacheOutcome, ExecAction, ExecOutcome, ExecutionService, SandboxRetention};
use imp_execution::service::LocalExecutionService;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tonic::transport::Channel;
use tonic::Request;

use crate::client::{ensure_protocol_match, RemoteExecutionService};
use crate::proto::{self, execution_client::ExecutionClient};
use crate::server::ExecutionServer;
use crate::{convert, lifecycle, PROTOCOL_VERSION};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

static CACHE_ENV: Once = Once::new();
static DAEMON_ADDR_LOCK: Mutex<()> = Mutex::new(());

/// Point the whole test binary's cache and sandbox roots at throwaway
/// directories, once, before any `imp-store` cache access. `cache_root()`
/// memoises its answer, so this must win the race against the first lookup —
/// it does, because every cache-touching test calls this first and the only
/// other test in the crate (`parse_address`) never reaches the cache.
fn isolate_cache_env() {
    CACHE_ENV.call_once(|| {
        let base = tempfile::Builder::new()
            .prefix("imp-daemon-tests-")
            .tempdir()
            .expect("create test cache root");
        // The directory must outlive every test in the process.
        let base = Box::leak(Box::new(base));
        let cache = base.path().join("cache");
        let sandbox = base.path().join("sandbox");
        std::fs::create_dir_all(&cache).expect("create test cache dir");
        std::fs::create_dir_all(&sandbox).expect("create test sandbox dir");
        std::env::set_var("IMP_CACHE_DIR", &cache);
        std::env::set_var("IMP_SANDBOX_DIR", &sandbox);
    });
}

/// Serialise the tests that mutate `IMP_DAEMON_ADDR`. A poisoned lock from an
/// unrelated panic must not cascade into every later test.
fn daemon_addr_lock() -> MutexGuard<'static, ()> {
    DAEMON_ADDR_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn empty_input_digest() -> String {
    imp_store::digest::merge_digests(Vec::new())
        .expect("merge empty digest set")
        .digest()
        .to_owned()
}

/// A hermetic action that prints `hi` and declares no outputs. The nonce goes
/// into `config_digest` (folded into the task key), so two calls with the same
/// nonce share a cache entry and two calls with different nonces do not.
fn nonce_action(nonce: &str) -> ExecAction {
    ExecAction {
        argv: vec![
            "sh".to_owned(),
            "-c".to_owned(),
            "printf 'hi\\n'".to_owned(),
        ],
        display: format!("daemon test {nonce}"),
        env: BTreeMap::new(),
        config_digest: format!("daemon-test-nonce-{nonce}"),
        input_digest: empty_input_digest(),
        outputs: Vec::new(),
        tools: Vec::new(),
        cores: 1,
        impure: false,
        force_cache: false,
        no_cache: false,
        sandbox_retention: SandboxRetention::Never,
        allow_failure: false,
    }
}

struct RunningServer {
    addr: SocketAddr,
    shutdown: std::sync::Arc<Notify>,
    handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

async fn start_server(protocol_version: u32) -> RunningServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback listener");
    let addr = listener.local_addr().expect("read listener address");
    let shutdown = std::sync::Arc::new(Notify::new());
    let service = ExecutionServer {
        service: std::sync::Arc::new(LocalExecutionService::new()),
        shutdown: shutdown.clone(),
        protocol_version,
    };
    let handle = tokio::spawn(lifecycle::serve_on(listener, service, shutdown.clone()));
    RunningServer {
        addr,
        shutdown,
        handle,
    }
}

impl RunningServer {
    async fn client(&self) -> ExecutionClient<Channel> {
        ExecutionClient::connect(format!("http://{}", self.addr))
            .await
            .expect("connect test client")
    }

    async fn stop(self) {
        self.shutdown.notify_waiters();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.handle).await;
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Ev {
    Phase(u32),
    Started,
    Finished,
}

/// Run one action over the `Execute` stream, returning the ordered event tags
/// and the final outcome. Panics if the daemon reports a failure.
async fn execute_collect(
    client: &mut ExecutionClient<Channel>,
    action: ExecAction,
) -> (Vec<Ev>, ExecOutcome) {
    let request = proto::ExecuteRequest {
        workspace_id: "daemon-tests".to_owned(),
        action: Some(convert::action_to_proto(action)),
    };
    let mut stream = client
        .execute(Request::new(request))
        .await
        .expect("execute rpc")
        .into_inner();

    let mut events = Vec::new();
    let mut outcome = None;
    while let Some(event) = stream.message().await.expect("read event stream") {
        match event.event.expect("event payload") {
            proto::execute_event::Event::Phase(phase) => events.push(Ev::Phase(phase.phase)),
            proto::execute_event::Event::Started(_) => events.push(Ev::Started),
            proto::execute_event::Event::Finished(finished) => {
                events.push(Ev::Finished);
                match finished.result.expect("finished result") {
                    proto::finished::Result::Outcome(o) => {
                        outcome = Some(convert::outcome_from_proto(o));
                    }
                    proto::finished::Result::Failure(f) => {
                        panic!("daemon action failed: {}", f.message)
                    }
                }
            }
        }
    }
    (
        events,
        outcome.expect("stream ended without a Finished(Outcome)"),
    )
}

fn assert_outcome_eq(local: &ExecOutcome, daemon: &ExecOutcome) {
    assert_eq!(local.exit_code, daemon.exit_code, "exit_code");
    assert_eq!(local.stdout, daemon.stdout, "stdout");
    assert_eq!(local.stderr, daemon.stderr, "stderr");
    assert_eq!(local.output_digest, daemon.output_digest, "output_digest");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[test]
fn ensure_protocol_match_flags_a_version_gap() {
    assert!(ensure_protocol_match(PROTOCOL_VERSION, PROTOCOL_VERSION).is_ok());
    let error = ensure_protocol_match(1, 2).unwrap_err().to_string();
    assert!(error.contains("protocol mismatch"), "{error}");
    assert!(error.contains('1') && error.contains('2'), "{error}");
}

#[tokio::test]
async fn serve_on_binds_a_loopback_port() {
    let server = start_server(PROTOCOL_VERSION).await;
    assert!(
        server.addr.ip().is_loopback(),
        "daemon must bind loopback, bound {}",
        server.addr
    );
    let mut client = server.client().await;
    let caps = client
        .get_capabilities(Request::new(proto::Empty {}))
        .await
        .expect("capabilities rpc")
        .into_inner();
    assert_eq!(caps.protocol_version, PROTOCOL_VERSION);
    server.stop().await;
}

#[tokio::test]
async fn get_capabilities_reports_the_servers_protocol_version() {
    let server = start_server(PROTOCOL_VERSION + 1).await;
    let mut client = server.client().await;
    let caps = client
        .get_capabilities(Request::new(proto::Empty {}))
        .await
        .expect("capabilities rpc")
        .into_inner();
    assert_eq!(caps.protocol_version, PROTOCOL_VERSION + 1);
    assert!(
        ensure_protocol_match(PROTOCOL_VERSION, caps.protocol_version).is_err(),
        "the client must reject a server one version ahead"
    );
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_fails_fast_on_a_protocol_mismatch() {
    let _guard = daemon_addr_lock();
    let server = start_server(PROTOCOL_VERSION + 1).await;
    let previous = std::env::var("IMP_DAEMON_ADDR").ok();
    std::env::set_var("IMP_DAEMON_ADDR", server.addr.to_string());

    let start = Instant::now();
    let result = tokio::task::spawn_blocking(RemoteExecutionService::connect)
        .await
        .expect("connect join");

    match previous {
        Some(value) => std::env::set_var("IMP_DAEMON_ADDR", value),
        None => std::env::remove_var("IMP_DAEMON_ADDR"),
    }

    let error = result
        .err()
        .expect("a protocol mismatch must fail the connection")
        .to_string();
    assert!(error.contains("protocol mismatch"), "{error}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "a mismatch must fail immediately, not after the spawn-and-retry loop"
    );
    server.stop().await;
}

#[tokio::test]
async fn shutdown_rpc_stops_the_server_cleanly() {
    let server = start_server(PROTOCOL_VERSION).await;
    let mut client = server.client().await;
    let handle = server.handle;

    client
        .shutdown(Request::new(proto::Empty {}))
        .await
        .expect("shutdown rpc");

    let joined = tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("server did not stop within 5s of Shutdown");
    joined
        .expect("server task panicked")
        .expect("server returned an error on shutdown");
}

// ---------------------------------------------------------------------------
// Execution: event order and parity
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
#[tokio::test]
async fn execute_streams_lifecycle_events_then_replays_from_cache() {
    isolate_cache_env();
    let server = start_server(PROTOCOL_VERSION).await;
    let mut client = server.client().await;

    let (events, outcome) = execute_collect(&mut client, nonce_action("stream-order")).await;
    assert_eq!(
        events,
        vec![
            Ev::Phase(1),
            Ev::Phase(2),
            Ev::Phase(3),
            Ev::Started,
            Ev::Phase(4),
            Ev::Phase(5),
            Ev::Finished,
        ],
        "cache-miss lifecycle events must arrive in executor order"
    );
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(outcome.stdout, "hi\n");
    assert_eq!(outcome.cache_outcome, CacheOutcome::Fresh);

    let (events, outcome) = execute_collect(&mut client, nonce_action("stream-order")).await;
    assert_eq!(
        events,
        vec![Ev::Finished],
        "a cache hit emits only Finished, no phases or Started"
    );
    assert_eq!(outcome.cache_outcome, CacheOutcome::HitLocal);
    assert_eq!(outcome.stdout, "hi\n");

    server.stop().await;
}

#[cfg(not(windows))]
#[tokio::test(flavor = "multi_thread")]
async fn daemon_and_in_process_outcomes_match_on_miss_and_hit() {
    isolate_cache_env();
    let server = start_server(PROTOCOL_VERSION).await;
    let mut client = server.client().await;

    // In-process: a cold miss then a local hit on the same action.
    let local = std::sync::Arc::new(LocalExecutionService::new());
    let local_miss = run_in_process(&local, "parity-local").await;
    let local_hit = run_in_process(&local, "parity-local").await;

    // Through the daemon: an independent action, same shape.
    let (_, daemon_miss) = execute_collect(&mut client, nonce_action("parity-daemon")).await;
    let (_, daemon_hit) = execute_collect(&mut client, nonce_action("parity-daemon")).await;

    assert_eq!(local_miss.cache_outcome, CacheOutcome::Fresh, "local miss");
    assert_eq!(
        daemon_miss.cache_outcome,
        CacheOutcome::Fresh,
        "daemon miss"
    );
    assert_eq!(local_hit.cache_outcome, CacheOutcome::HitLocal, "local hit");
    assert_eq!(
        daemon_hit.cache_outcome,
        CacheOutcome::HitLocal,
        "daemon hit"
    );

    assert_outcome_eq(&local_miss, &daemon_miss);
    assert_outcome_eq(&local_hit, &daemon_hit);
    assert_eq!(daemon_miss.stdout, "hi\n");

    server.stop().await;
}

#[cfg(not(windows))]
async fn run_in_process(
    service: &std::sync::Arc<LocalExecutionService>,
    nonce: &str,
) -> ExecOutcome {
    let service = std::sync::Arc::clone(service);
    let nonce = nonce.to_owned();
    tokio::task::spawn_blocking(move || service.execute("daemon-tests", nonce_action(&nonce), None))
        .await
        .expect("in-process join")
        .expect("in-process execution")
}
