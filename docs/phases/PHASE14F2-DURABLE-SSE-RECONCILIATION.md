# Phase 14F.2 — Durable SSE tail, backpressure and transient-gap reconciliation

**Date:** 2026-11-01  
**Status:** Implemented and host-verified; Phase 14F remains open.

## Scope

This slice hardens the existing browser event stream without changing the HTTP/SSE contract or introducing another event broker. It addresses durable tail visibility across daemon-owned child-worker writes, bounded transient delivery, explicit recovery after live-frame loss, and serialized writes under Node response backpressure.

It does **not** make the interactive terminal a daemon client. Terminal attachment, shared command transport, cross-client interaction convergence and physical Android/Brave testing remain later Phase 14F work.

## Implementation

### 1. Durable JSONL remains authoritative

`SessionEventBus` remains a process-local wakeup optimization. It is not treated as a durable event source and is not extended into a cross-process broker.

The SSE tail now wakes on either a local event-bus notification or a bounded one-second durable-tail poll. On each wake, it reads the append-only session log from the last delivered durable sequence. This makes the SSE tail observe durable events appended by independent SessionStore writers, such as the daemon-managed task manager/worker paths, that do not share the daemon's in-memory event bus. A second independent runtime remains unsupported; workspace owner fencing from Phase 14F.1 is still the single-writer boundary.

### 2. Transient live buffers report loss explicitly

Each event-bus subscriber retains a bounded live buffer of 128 frames. Text and reasoning deltas for the same stream continue to coalesce. When a non-coalescible frame exceeds the buffer budget, the oldest frame is dropped and an overflow marker is retained.

The server drains the transient buffer with `drainLiveWithGap()`. If frames were dropped, it sends an SSE `gap` frame with `reason: live-buffer-overflow`, the current durable sequence and `snapshotRequired: true`. The browser does not advance its durable cursor from this live-only frame; it fetches the canonical session snapshot and reconciles its state before continuing.

Durable session events are not dropped by this live-frame budget. Reconnect still uses the caller's last durable sequence and replays the JSONL log.

### 3. Response backpressure and write ordering

All frames in the durable session event stream now use `writeSse()`. When `ServerResponse.write()` returns `false`, the writer waits for `drain`, or resolves as disconnected on `close`/`error`. The stream does not continue emitting the next frame until the current write is accepted.

Heartbeat/re-authorization writes were moved into the stream's single async loop. This prevents a timer callback from writing concurrently with replay/live frames or creating a second producer while the response is backpressured. Heartbeat authorization is still periodically rechecked for long-lived paired-device streams.

### 4. Client reconciliation

The Web View handles the `gap` frame by requesting a canonical snapshot. The gap frame itself never changes the durable sequence cursor. The snapshot's sequence/revision becomes the reconciliation point; subsequent durable events remain replayable from the canonical cursor.

## Upstream research and adaptation

The OpenCode V2 event-stream architecture was read at:

`https://github.com/anomalyco/opencode/blob/97a71f0cc624f128906224ca73d9e4016b43fde0/specs/v2/event-stream-architecture.md`

Its key ideas include a server-scoped feed, encoding public frames once, an independent bounded queue per connection, non-blocking publication, explicit slow-subscriber overflow, connection-local `server.connected`/heartbeat frames, and keeping the wire schema stable.

TermAgent adopts the relevant delivery laws, not the OpenCode implementation wholesale. TermAgent already has durable per-session JSONL events and a runtime-owned wakeup bus. Therefore this slice keeps JSONL + sequence as truth, keeps the bus local, adds a bounded one-second durable tail poll for daemon-managed child writers, and emits a snapshot-reconciliation gap when transient frames overflow. It does not introduce Effect PubSub, a second feed abstraction, or an inter-process event broker. HTTP/SSE schemas remain unchanged apart from the additive `gap` frame already understood by the Web View client.

## Verification

Host verification for this slice:

- `npm run build`: PASS.
- `node --check web/app/app.js`: PASS.
- `node scripts/verify-dist.mjs`: PASS; `node dist/index.js --version`: `1.18.0`; `npm pack --dry-run`: PASS.
- Event stream and Web View focused tests: 13/13 PASS after the direct backpressure-writer test was added.
- Covered: replay-then-tail ordering, reconnect from a durable cursor, durable tail observation when a second `SessionStore` writes without sharing the bus, 128-frame transient bound and overflow marker, browser snapshot reconciliation, timed bus wakeups, SSE drain waiting, and disconnect while awaiting drain.

The combined Phase 14A–14F focused regression gate also passed **58/58**; the exact command and aggregate are recorded in `PROGRESS.md`. The repository-wide test suite and physical mobile browser are not claimed as verified by this slice.

## Remaining Phase 14F work

- Convert the interactive TerminalUI/REPL into a typed daemon client.
- Reuse the canonical command envelope and command handlers from the browser.
- Route terminal permission/question decisions and cancellation to the daemon-owned runtime.
- Prove two-browser + terminal convergence, command idempotency and competing interaction decisions.
- Verify reconnect, detach/reattach, active-run cancellation and daemon restart through the actual clients.
- Run physical Android/Termux/Brave/Chrome and network-handoff tests.

**Conclusion:** Phase 14F.2 closes the SSE tail/backpressure/transient-gap sub-gate. It does not close Phase 14F or establish terminal/browser client parity.
