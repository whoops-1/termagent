# TermAgent Protocol

TermAgent's protocol is renderer-neutral. Terminal, browser, and future VS Code clients use the same semantic command and event model; no client is allowed to make a renderer-specific version of runtime truth.

## EventEnvelope

```text
version
eventId
sessionId
sequence      durable cursor, or null for live-only events
timestamp
category
kind
durable
payload
```

Durable events use a positive monotonically increasing session sequence. Live-only events use `sequence: null` and are not part of durable replay. The current protocol recognizes durable session lifecycle, message, reasoning/tool, task, Todo, permission, question, compaction, mutation, diff, skill, provider, and history events, plus live streaming/activity/heartbeat/connection events.

## CommandEnvelope

```text
version
commandId
clientId
sessionId
issuedAt
expectedSequence?
expectedRevision?
kind
payload
```

`commandId` is the retry/idempotency identity within a client/session pair. The semantic command fingerprint includes the command kind, session, expected-state guards, and payload. Reusing an idempotency key with different semantics is rejected.

## Interaction state

Permission and question requests are durable session state. A client may reconnect and reconstruct pending requests from the event log. Resolution is first-writer-wins. Later concurrent or retried resolutions observe the already-resolved state instead of re-running the side effect.

## Compatibility

Older JSONL session records without explicit event metadata remain readable. They receive deterministic compatibility sequence/event metadata when projected through the protocol layer. All newly appended session events persist the public metadata directly.

## Reconnect

The current Phase 14A contract defines the durable cursor and reconciliation model. Phase 14B adds the live publisher/subscriber implementation and replay-then-tail connection lifecycle.

## Source

The protocol implementation lives under the relevant TermAgent subsystem. HTTP/SSE, browser, and VS Code code must treat these schemas as the contract rather than defining parallel business semantics.
