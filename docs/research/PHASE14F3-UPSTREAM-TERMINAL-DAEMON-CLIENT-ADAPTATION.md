# Phase 14F.3 — Upstream terminal/daemon client research and adaptation

## Research question

How does an interactive terminal become a client of a reusable daemon while ensuring multiple CLI/TUI invocations reuse one authoritative runtime rather than starting independent Agent instances?

## OpenCode findings

### Service discovery contract

`packages/client/src/service.ts` defines an endpoint and service registration containing a server URL, PID, version, optional instance ID and private credential. Discovery options include a registration file and version-compatibility policy.

### Probe before reuse

`packages/client/src/service-probe.ts` constructs authenticated requests and probes `/api/info`. It checks that the server is reachable, reports the registered PID, reports a matching version where one is recorded, and classifies the result as ready, waiting, failed or protocol-incompatible. A JSON file alone is not considered proof that a live daemon is healthy.

### Ensure/reuse lifecycle

`packages/client/src/promise/service.ts` and `packages/client/src/effect/service.ts` implement `discover`, `ensure` and `stop`. `ensure` reuses a healthy compatible service, handles explicit version mismatch policy, and starts bounded contenders when registration is missing or stale. Termination compares the exact registration before signaling and again before removing it, so an old client does not remove a successor's registration.

### CLI connection selection

`packages/cli/src/services/server-connection.ts` separates three paths:

1. an explicit `--server` endpoint;
2. a private `--standalone` process;
3. a managed service discovered/ensured through the service config.

The normal CLI path builds an HTTP API client for the managed endpoint. Restart/reconnect also goes through the shared service lifecycle instead of constructing an application runtime inside the TUI process.

### Project-level architecture statement

The retrieved OpenCode development skill explicitly describes the server as owner of sessions, database, plugins, permissions and runtime state. The TUI is a separate HTTP/SSE client. A private registration file plus an authenticated `/api/info` health probe allows concurrent CLI invocations to converge on one server. Standalone mode is an opt-out for a private isolated session.

### OpenClaude review

The supplied OpenClaude source was previously inspected during Phase 14F.1. Its `src/server/lockfile.ts` is an inert/no-op stub; it did not provide a reusable daemon lock implementation and was not copied.

## TermAgent adaptation

| Upstream concept | TermAgent adaptation |
| --- | --- |
| Private server registration | Existing `src/server/daemon-owner.ts` workspace lease and safe owner metadata |
| Authenticated health probe | `TermAgentClient.info()` + `health()` and owner ID/PID/state comparison |
| Reuse an existing compatible daemon | `src/cli/repl.ts` attaches through `src/cli/daemon-client.ts` before constructing local runtime state |
| Separate standalone mode | Existing terminal owner path remains when no server owns the workspace |
| HTTP API client | Existing dependency-free typed `TermAgentClient` and protocol routes |
| Server owns runtime | Daemon-owned Agent/PermissionGate/SessionStore/TaskManager/provider/event bus and queue worker |
| Long-lived event subscription | Existing durable JSONL sequence replay + transient SSE events + gap snapshot reconciliation |
| Service credential | Existing device pairing/scopes; terminal device credential persisted locally with 0700/0600 permissions |

TermAgent does not copy OpenCode's registration file format, Effect package, contender pool, or command layout. Its existing daemon owner lease and pairing/security contracts are authoritative, and only the discovery/probe/client ownership principles were adopted.

## Integration issues discovered

The queue worker made an API/ledger concurrency bug observable. The API had started a detached worker from inside the `CommandLedger` callback. That worker inherited the active `SessionStore` mutation context and could interleave durable appends with the still-open command receipt mutation. A process-wide mutation-depth counter also treated unrelated asynchronous work as nested.

The adaptation fixes this with async-context-scoped reentrancy (`AsyncLocalStorage`) and schedules the queue worker only after the command ledger transaction has completed. This keeps sequence assignment serialized without adding a shared event broker or a second runtime owner.

## Deliberate differences and non-goals

- TermAgent uses one workspace owner and its own lease; it does not adopt OpenCode's service registration file as the owner lock.
- TermAgent continues using HTTP + SSE. WebSocket is not introduced.
- Auto-attachment is loopback-only. Explicit remote terminal connection is deferred until a dedicated remote-device flow is designed and verified.
- Terminal credential persistence is per-workspace, owner-only, and tied to the paired device ID.
- The daemon-client command catalog is intentionally partial in this increment; standalone-only advanced configuration and plugin surfaces are not falsely presented as shared-runtime capable.
- No support for multiple independent writers is added. JSONL durable sequences and the daemon-owned EventBus remain under one runtime owner.
