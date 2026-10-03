# Phase 14A Report — Canonical Event Log and Interaction Model

## Status

**Complete.** Phase 14A establishes the canonical durable event and client-neutral interaction foundation for Web View and later VS Code clients. Phase 14B remains the next unstarted subphase.

## Scope completed

- Durable session events now receive a positive monotonic sequence under the existing per-session process queue and cross-process state lease.
- New event records persist `eventId`, protocol version, category, kind, durable marker, and sequence together.
- Public durable-event projection and paging use the durable sequence cursor.
- Official durable and live-only event families are defined in the relevant TermAgent subsystem.
- Live-only frames have `sequence: null` and are never written as durable session events.
- `EventEnvelope` and `CommandEnvelope` are versioned and validated.
- `CommandLedger` provides deterministic command idempotency, semantic conflict detection, expected-sequence/revision checks, and durable command receipts.
- Permission and question requests are reconstructible from durable session events and resolve using first-writer-wins semantics.
- An incomplete trailing JSONL write is repaired before the next append; newline-terminated corruption fails closed.
- A `toLiveEventEnvelope()` helper supplies renderer-neutral transient frames without coupling protocol code to any transport.

## Architecture boundary

`SessionStore` remains the sole durable session truth. the relevant TermAgent subsystem owns wire-neutral schemas. the relevant TermAgent subsystem owns client-neutral command admission and request semantics. The terminal remains a renderer/client and the future browser/VS Code clients will use the same contracts.

Phase 14A intentionally does **not** implement the runtime event bus, replay-then-tail streaming, HTTP/SSE refactor, browser UI, remote pairing, or WebSocket transport. Those belong to later Phase 14 subphases.
The implementation was designed around the documented event-sequencing and interaction requirements already recorded for TermAgent.

The resulting semantic model uses aggregate/session-scoped durable sequencing, durable replay, explicit interaction state, and semantic command/event separation on TermAgent's dependency-free JSONL runtime.

## Verification

`tests/phase14a-event-interaction.test.mjs` — **13/13 PASS**.

Additional checks:

- `npm run build` — PASS
- 13A-L + P2-P7 + 14A focused regression — PASS for the executed files; the aggregate command remains subject to the previously documented per-file test-runner behavior.
- `node --check` on all generated `dist/*.js` — PASS (132 files)
- `npm pack --dry-run` — PASS (353 package files)
- cross-process sequence assignment — PASS
- cross-process command idempotency — PASS
- legacy event compatibility — PASS
- permission/question restart reconstruction — PASS
- first-writer-wins resolution — PASS
- partial-tail recovery and corrupt-tail fail-closed handling — PASS

## Next boundary

**14B — Event bus and reconnect-safe streaming** must replace the current 250 ms session-file polling SSE path with runtime-owned publish/subscribe, race-free replay-then-tail semantics, ready/heartbeat frames, and snapshot reconciliation while preserving the Phase 14A sequence contract.
