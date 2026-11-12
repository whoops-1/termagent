# Phase 14F.2 — Upstream event-stream research and TermAgent adaptation

**Reviewed:** 2026-11-01  
**Primary upstream:** OpenCode V2 event-stream architecture, commit `97a71f0cc624f128906224ca73d9e4016b43fde0`.

## Source reviewed

- `specs/v2/event-stream-architecture.md`
- URL: https://github.com/anomalyco/opencode/blob/97a71f0cc624f128906224ca73d9e4016b43fde0/specs/v2/event-stream-architecture.md

The source describes a Server-scoped encoded event feed with one Core listener, public filtering and encoding once, then independent bounded queues for each HTTP connection. A slow consumer exceeds only its own lag budget and is evicted; publication and healthy consumers remain ordered and non-blocking. The HTTP adapter provides connection-local `server.connected` and heartbeat frames and encodes the resulting immutable SSE frames to bytes. The OpenCode spec explicitly keeps the public protocol and generated clients stable.

## TermAgent's existing architecture

TermAgent's Phase 14B/14C implementation already has a different but compatible foundation:

- SessionStore's append-only JSONL event log is durable truth.
- Monotonic event sequence is the reconnect cursor.
- SessionEventBus is runtime-local and is used only to wake SSE subscribers.
- Durable replay and snapshot APIs reconstruct client state.
- Live-only text/reasoning frames are bounded and have no durable sequence.
- Phase 14F.1 makes one daemon the exclusive owner of the runtime for a workspace.

A second unsupervised SessionStore/runtime writer is not supported under accepted ADR-019. A child worker owned by the daemon may append durable task/session records without sharing the parent process's in-memory bus; this is why the server cannot rely solely on EventBus notifications to find new durable log rows.

## Decisions adopted

1. Keep immutable durable sequence as the only reconnect cursor.
2. Keep live-only activity bounded, separate from durable events.
3. Never allow one slow HTTP write to make the server queue an unbounded amount of output.
4. Wait for Node's `drain` signal before writing another SSE frame.
5. Keep heartbeat and authorization re-checks serialized with the rest of the stream.
6. Signal transient-buffer loss explicitly and require authoritative snapshot reconciliation.
7. Preserve independent client subscription lifetimes; client disconnect only closes its subscription.
8. Keep HTTP/SSE and existing frame contracts; WebSocket remains deferred.

## Intentional differences from OpenCode

TermAgent does not copy OpenCode's server-side encoded-frame feed or its 4,096-frame per-connection queue. That design solves repeated schema/JSON/SSE encoding across many concurrent clients. TermAgent's current bottleneck and correctness concern is different: durable state can be appended by daemon-managed child workers without a process-local wakeup, and transient Web View deltas must not disappear silently.

Instead, TermAgent:

- polls the durable sequence every 1,000 ms as a fallback to local wakeups;
- replays from JSONL after the durable cursor;
- retains the existing 128-frame transient buffer and same-stream delta coalescing;
- marks overflow and emits a `gap` frame carrying the current durable sequence and `snapshotRequired` flag;
- makes the Web View fetch its canonical snapshot on that gap;
- uses a single serialized SSE writer that waits for response drain.

This is a deliberately smaller adaptation. If profiling later shows frame encoding duplicated across subscribers is material, a shared immutable encoded-frame feed can be reconsidered while retaining the existing durable sequence/reconciliation model. No such performance claim is made now.

## Non-goals

- No distributed PubSub or multi-daemon event bus.
- No change to command schemas or session event sequencing.
- No WebSocket transport.
- No terminal daemon client yet.
- No claim of Android device verification.
