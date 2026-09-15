+++
title = "The execution daemon"
weight = 15
template = "page.html"
+++

By default `imp` runs every sandboxed action in its own process. The execution
daemon is an opt-in alternative: a long-lived local service that runs those
actions on behalf of short-lived `imp` invocations, so a sandbox executor and
its warm state outlive a single command.

The daemon speaks `imp.exec.v1`, a gRPC service shaped after the Bazel Remote
Execution API v2 (the same CAS + action-cache split, the same
Action/Command/Directory digests). It fronts the **same** in-process executor
and the **same** shared cache root, so a daemon run and an in-process run of the
same action produce the same outcome.

## Selecting daemon execution

Pass the global `--daemon` flag on any command that executes actions:

**Illustrative example**

```
imp --daemon build //app
```

The flag routes sandboxed execution through the daemon for that invocation.
The first `--daemon` run auto-starts the daemon if one is not already running;
later runs reuse it.

## Lifecycle

```
imp daemon status    # report "running" or "stopped"
imp daemon serve      # run the daemon in the foreground (auto-started otherwise)
imp daemon stop       # ask a running daemon to exit
```

- **Loopback only.** The daemon binds `127.0.0.1:49671` by default. Set
  `IMP_DAEMON_ADDR` to choose another address; a non-loopback address is
  rejected.
- **Clean stop.** `imp daemon stop` (the `Shutdown` RPC) lets in-flight RPCs
  drain before the process exits.
- **Protocol check.** The client verifies the daemon's protocol version on
  connect. A mismatch fails fast with a clear message rather than starting a
  second daemon — restart the old one with `imp daemon stop`.
- **Build identity.** The client warns when the daemon's package version or
  compile-time build identity differs, but it keeps the connection usable.

## Parity with in-process execution

A daemon run uses the same executor, the same local and remote cache lookups,
and reports the same `CacheOutcome` (`Fresh`, `HitLocal`, `HitRemote`) and the
same lifecycle events, in the same order, as an in-process run.

The daemon also mirrors cancellation: dropping the client stream requests
cancellation of the action running in the daemon. Progress delivery uses a
separate forwarding task, so a slow client does not stall the daemon's
execution thread.

Not yet mirrored on the daemon path:

- An action's in-memory output value (for manifest artifacts) is not carried
  over the wire — only its digest and captured files.
- The daemon path takes no local `--jobs` slot, because the sandbox is staged
  in the daemon process.
- Streaming, `workspace_cwd`, and unsandboxed (`sandbox: false`) runs still
  execute in-process even under `--daemon`.
