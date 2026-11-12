# ADR-019: Single runtime daemon and HTTP/SSE event authority

**Status:** Accepted — Option A (single runtime daemon), 2026-11-01  
**Date:** 2026-11-01

## Context

Phase 14A/14B provides durable monotonic session events and a same-runtime replay/tail subscription. `SessionEventBus` itself is an in-memory object owned by one process. The browser and local CLI can start separate TermAgent runtimes against the same session JSONL. A write from one process does not wake another process's `SessionEventBus`; the current SSE heartbeat reports the durable sequence but does not replay missing rows. The turn lease prevents overlapping turns but the `activeControllers` map and event publisher remain process-local.

## Accepted decision — Option A: single long-lived runtime daemon

The project owner selected **Option A: one TermAgent runtime daemon**. This is now the authoritative local/multi-client topology.

- The daemon is the sole owner of Agent instances, `SessionStore` writers, `PermissionGate` waiters, `TaskManager` workers, active turn controllers, provider orchestration and the runtime `SessionEventBus`.
- Terminal UI and browser Web View are clients. They submit canonical commands and consume the same HTTP/SSE event/history/snapshot contract. The terminal must not construct a second Agent runtime for a session already owned by the daemon.
- Telegram adapters, when introduced, run as daemon-owned transport/delivery adapters. They do not create an independent agent or permission state.
- The daemon must enforce single ownership at startup (exclusive lock/lease with process identity and stale-owner recovery). A second invocation attaches as a client or exits with a clear owner endpoint; it must not start a competing runtime against the same session state.
- HTTP/SSE remains the browser and remote-client contract. A local IPC/Unix-socket adapter may be used for local terminal attachment if it reuses the same command/event schemas. This ADR does not mandate the exact local transport.
- Durable SessionStore events and monotonic cursors remain authoritative. A reconnecting client replays/reconciles by cursor; live-only events may be lost and must never become the only source of truth.
- Runtime restart recovery must explicitly settle interrupted turns/tasks as interrupted or recoverable. It must never synthesize a successful completion.

The earlier two-store probe remains a valid demonstration that two independent `SessionStore`/`SessionEventBus` instances do not notify one another. Under the accepted topology, concurrent independent runtime writers are not supported. Phase 14F must enforce the one-owner invariant and prove that all clients attach to that owner. Cross-process event brokers are deferred unless a later multi-daemon requirement is approved.


## Implementation status — Phase 14F.1

`src/server/daemon-owner.ts` now enforces a workspace-scoped exclusive file lease for `termagent --serve` and standalone terminal startup. Owner records include a random lease identity, PID and process-start identity where supported; a safe heartbeat/endpoint projection is published through authenticated `/health`. Stale records are reclaimed under a recovery guard and token-checked before release. After acquiring the lease, startup durably cancels orphaned pending interactions and marks unmatched started turns interrupted.

The interactive terminal is not yet a client of the daemon. Until that next implementation slice, starting it while the server owns the same workspace fails clearly rather than opening a competing runtime. This fulfills the second-launch safety branch of the decision, not the final terminal/browser client-parity requirement. See `docs/phases/PHASE14F1-DAEMON-OWNERSHIP.md`.

## Implementation status — Phase 14F.2

The browser SSE tail now combines runtime-local EventBus wakeups with a bounded one-second durable JSONL poll. This poll is a fallback for daemon-managed child workers that append durable records without sharing the parent process's in-memory bus; it is not a distributed event broker or permission for a second runtime writer. Durable replay continues from the last monotonic sequence.

Transient live frames remain bounded (128 per subscriber) and same-stream text/reasoning deltas coalesce. If the queue overflows, the stream emits an explicit `gap` frame and the Web View fetches the canonical snapshot. All SSE writes wait for Node response drain, and heartbeat/authorization checks are serialized in the same stream loop. See `docs/phases/PHASE14F2-DURABLE-SSE-RECONCILIATION.md` and `docs/research/PHASE14F2-UPSTREAM-EVENT-STREAM-ADAPTATION.md`.

The interactive terminal is still not attached as a daemon client. Phase 14F remains open until the terminal sends canonical commands to the same runtime and terminal/browser clients prove convergence.

## Transport decision

Keep HTTP commands and fetch-based SSE as the default client contract. Do not add WebSockets without measured evidence. `SessionEventBus` remains a bounded in-daemon wakeup mechanism; the JSONL log and monotonic sequence remain durable truth. Reconnects, slow consumers, write backpressure and transient gaps must trigger durable-cursor reconciliation.

## Consequences

- No immediate WebSocket dependency.
- Durable event replay remains the source of truth.
- Phase 14B's same-daemon replay/tail tests remain authoritative; add owner-lock and duplicate-daemon integration tests rather than building cross-process EventBus delivery.
- Client state can be reconciled after process death or backgrounded mobile browser tabs.
