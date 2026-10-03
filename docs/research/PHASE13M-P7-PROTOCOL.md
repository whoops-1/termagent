# Phase 13M-P7 — Client/runtime protocol preparation

## Scope

P7 defines the transport-neutral contract required before TermAgent can safely expose the same runtime to TerminalUI, a browser Web View, and a future VS Code integration. It is preparation only. No browser application, HTTP route migration, event bus, durable sequence persistence, or WebSocket implementation is introduced here.
The inspected session protocol defines a durable session history and a session event stream using an exclusive aggregate sequence cursor. Its durable event schema separates replayable lifecycle/value boundaries from live-only stream deltas. Session command routes are explicit, including prompt, interruption, context/history, permissions, and questions. The generated client uses a transport-neutral request layer and a streaming SSE reader rather than making browser APIs part of the protocol.

Relevant inspected files:
The supplied the implementation was inspected directly from `the transport notes used during protocol design`. Its bridge/transport design carries an SSE sequence high-water mark across transport replacement and process restart, sends the cursor on reconnect, deduplicates redelivered inbound messages, and treats WebSocket/SSE/HTTP as transport mechanisms around one session/control model. The bridge also keeps per-instance authentication sources separate so concurrent sessions do not overwrite a process-global token source.

Relevant inspected files include:
## TermAgent protocol decisions

### EventEnvelope

The public event boundary is:

```text
EventEnvelope {
  version
  eventId
  sessionId
  sequence
  timestamp
  kind
  durable
  payload
}
```

Durable events carry a positive `DurableSequence`. Sequence `0` is reserved for an initial/reconnect cursor and is never emitted as a durable event sequence. Live-only events carry `sequence: null` and `durable: false`; therefore a live token delta can never advance a durable recovery cursor.

The sequence is an independent runtime value. JSONL array offsets, request-local indexes, renderer message counts, or the number of events returned by one HTTP request are not protocol sequence sources.

Known event families are classified centrally. Unknown future event kinds remain extensible but must declare their durability explicitly at the envelope boundary.

### CommandEnvelope

The command boundary is:

```text
CommandEnvelope {
  version
  commandId
  clientId
  sessionId
  issuedAt
  expectedSequence?
  expectedRevision?
  kind
  payload
}
```

`commandId + clientId + sessionId` is the idempotency scope. The protocol also exposes a canonical command fingerprint over meaningful command content so a reused idempotency key with different semantics can be rejected as an idempotency conflict rather than silently treated as the same request.

`expectedSequence` and `expectedRevision` are optional compare-and-set guards. A command with a mismatched guard is stale and must not silently overwrite newer authoritative state.

A duplicate delivery with the same idempotency key and same fingerprint is a deterministic replay/no-op. A duplicate key with a different fingerprint is an idempotency conflict.

### Permission/question request state

P7 defines wire-level request state only. The authoritative runtime owner remains the future the relevant TermAgent subsystem subsystem.

Permission state records:

- stable request ID
- session ID
- monotonic request revision
- pending/resolved/cancelled state
- tool/action/resources
- resolution command/client identity
- once/always/deny decision

Question state records:

- stable request ID
- session ID
- monotonic request revision
- pending/replied/rejected/cancelled state
- structured questions/options
- resolution command/client identity
- answers when applicable

The protocol helper `firstWriterWins()` defines the concurrency rule: only a pending request may be resolved. The first valid resolution changes the request revision/status; later decisions return `already-resolved` without changing state.

### Reconnect and reconciliation

Each client supplies:

```text
ReconnectRequest {
  version
  clientId
  sessionId
  lastDurableSequence
  knownRevision?
}
```

The authoritative state snapshot is explicitly versioned and reports the sequence at which it was captured:

```text
ReconciliationSnapshot {
  version
  sessionId
  sequence
  revision
  capturedAt
  state
}
```

The reconnect planner distinguishes two cases:

1. `replay`: the client's cursor is still replayable and its known revision is compatible. The client can request events strictly after `lastDurableSequence`.
2. `snapshot-and-replay`: the client's cursor is stale/unavailable or its known revision no longer matches. The runtime sends an authoritative snapshot boundary, then future events are replayed after that snapshot sequence.

The actual race-free replay-then-tail subscription is intentionally deferred to Phase 14B. P7 only freezes the cursor and reconciliation semantics it must implement.

### Event-stream readiness

The future event stream can expose a ready frame containing:

```text
currentSequence
replayAfter
snapshotRequired
```

This lets clients distinguish connection establishment from durable event delivery and makes the recovery boundary explicit instead of encoding it in ad-hoc SSE comments or renderer state.

## Compatibility

Protocol version `1` is currently the only supported version. External inputs are validated immediately and reject unsupported versions rather than silently interpreting a future schema as the current one.

The public `./protocol` package export is added now so future clients can share the same wire types without importing runtime, server, browser, or CLI code.

## Explicitly deferred to Phase 14

- assigning and persisting durable sequences inside `SessionStore`;
- runtime-owned event publisher/subscriber;
- race-free replay-then-tail streaming;
- migration of current polling SSE routes;
- durable pending permission/question storage;
- canonical command admission store;
- browser application;
- WebSocket transport.

## Verification

P7 focused tests cover event durability/sequence rules, command idempotency and stale guards, first-writer-wins question resolution, reconnect cursor/snapshot semantics, and strict validation.
