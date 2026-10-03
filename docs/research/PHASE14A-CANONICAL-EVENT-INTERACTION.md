# Phase 14A — Canonical event log and interaction model

## Scope

Implement the first production seam for TermAgent's future multi-client runtime: durable monotonic session-event sequencing, renderer-neutral event classification/envelopes, idempotent commands with stale-state guards, deterministic permission/question resolution, and reconstructible interaction state. Browser UI and live event-bus transport are explicitly deferred to Phase 14B+.
Phase 14A defines the canonical event and command boundary for the future multi-client runtime. The current implementation uses the existing JSONL session store with a cross-process lease for durable sequence assignment, while `SessionStore` and `CommandLedger` keep durable admission separate from active execution.

The event/command contracts are renderer-neutral, replayable, idempotent, and safe against stale revisions. Reconnect behavior is defined in terms of semantic state rather than terminal output.

## Implementation

### Durable sequence

`SessionStore.append()` now assigns the next durable sequence while holding the existing per-session process queue and cross-process state lease. The sequence, event ID, protocol version, category, kind, and durable marker are persisted together in the event record. Existing records lacking explicit sequence metadata receive deterministic compatibility sequence values when projected.

The store exposes `currentSequence()` and `durableEvents(after, limit)`. The latter is cursor-based and asserts strict monotonicity of projected durable sequences. New writes never use an array offset as their authoritative sequence.

### Event classification

the relevant TermAgent subsystem defines the official durable/live event families. Durable events cover session lifecycle, messages, reasoning/tool lifecycle, tasks, Todo, permissions, questions, compaction, mutations, diffs, skills, provider-visible state, history, and command receipts. High-frequency text/reasoning/tool-output deltas plus runtime activity/status/heartbeat/connection events are explicitly live-only.

the relevant TermAgent subsystem handles legacy event projection and provides `toLiveEventEnvelope()` for live semantic frames. the relevant TermAgent subsystem rejects mismatched durability classifications and forbids durable cursors on live events.

### Command model

`CommandEnvelope` includes version, command/session/client identities, issued time, semantic kind/payload, and optional expected sequence/revision guards. `CommandLedger` serializes admission per session, returns the original receipt for an exact retry, rejects semantic reuse of an existing idempotency key, and rejects stale expected state before running the handler.

Command receipts are durable session events, so client retries can be reconciled after a process restart. The current receipt design represents completed command admission; Phase 14B/14C may extend the command lifecycle when transport adapters need richer in-flight recovery.

### Permission/question state

Permission and question requests are projected from durable `permission.asked` / resolution and `question.asked` / resolution events. Pending state is therefore reconstructible without an HTTP request-local map. Resolutions use first-writer-wins semantics under the session mutation lock, then append the resulting durable resolution event.

### JSONL crash recovery

The store now repairs an actually incomplete final JSONL line before assigning the next sequence. A newline-terminated corrupt final record is treated differently: it is considered corruption and fails closed instead of silently deleting persisted data.

## Explicit Phase 14A boundary

The runtime event publisher/subscriber boundary is not implemented here. the relevant TermAgent subsystem still contains the transitional polling SSE implementation and request-local question callback wiring. That is intentionally the first target of Phase 14B, along with race-free replay-then-tail subscriptions.

## Verification

Focused Phase 14A verification: **13/13 tests passed**. Production TypeScript build passes. Cross-process durable sequence, cross-process command idempotency, stale command admission, legacy compatibility, live-only classification, crash-tail recovery, and interaction reconstruction all pass.

## Decision

Phase 14A establishes `SessionStore` as durable truth, the relevant TermAgent subsystem as the public semantic contract, and the relevant TermAgent subsystem as the client-neutral command/request boundary. Phase 14B must build on these primitives instead of introducing a second session-event store or client-specific business logic.
