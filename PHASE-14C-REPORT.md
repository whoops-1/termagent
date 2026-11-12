# TermAgent 1.18.0 — Phase 14C Report

## Status

**Implemented and focused-verified. Overall Phase 14 gate remains open.**

Phase 14C converts the Phase 14A/14B semantic runtime contract into a stable HTTP API and dependency-free client SDK. The browser itself is intentionally deferred to Phase 14D.

## Upstream basis

- OpenCode pinned Phase 13 revision: `7945de208964a49300d7f770d1a71d078db9a4c4`.
- OpenCode current V2 session/SDK contract was also reviewed where the pinned tree has moved. The key pattern is durable sequence based session history/event replay, route contracts separated from handlers, and typed generated-client behavior without placing reconnection policy inside the generated client.
- OpenClaude pinned revision: `9a2910da236395d259c72c3b4ddf92278625a6c1`, used for client/bridge/reconnect architectural comparison.
- LaudaCode pinned revision: `f8906ce9da3b11c83fca4b296e0a90f5c7d39110`, used as a secondary reference for keeping runtime task/session ownership separate from presentation.

## Implementation

### HTTP transport boundary

`src/server/http.ts` performs HTTP concerns only: authentication, request body bounds, JSON decoding, path/query decoding, status/headers, SSE framing, and construction of canonical `CommandEnvelope` values. State changes enter the existing `CommandLedger` and runtime services.

### Canonical API adapter

`src/server/api.ts` adapts validated protocol requests to `SessionStore`, `SessionEventBus`, `SessionPromptQueue`, `TaskManager`, checkpoint/snapshot state, and the existing runtime. No second session or execution engine was introduced.

### Public protocol contract

`src/protocol/api.ts` defines the route inventory and public data shapes. `src/protocol/types.ts` remains authoritative for event and command envelopes, durable sequence rules, interaction resolution, and reconciliation.

### Dependency-free client

`src/client/client.ts` depends only on public protocol modules and standard Fetch/Streams/Abort APIs. It supports JSON requests, bearer auth, merged headers, typed session/task/interaction accessors, command submission, and fetch-based SSE.

The event client tracks only durable sequence values. Reconnects explicitly resume from the last observed durable sequence, while live-only connection/heartbeat fragments do not advance it. Browser `EventSource` is not used, allowing header-based authentication.

## Correctness finding during implementation

Route drift tests found that the declared stable checkpoint-create route was plural (`POST /api/v1/sessions/:sessionId/checkpoints`) while the legacy server exposed only `/checkpoint`. The plural route is now canonical and the singular route remains as a compatibility alias.

The same tests found missing queue command kinds in protocol validation. `session.queue.edit`, `session.queue.cancel`, and `session.queue.move` are now accepted by the canonical command validator.

## Tests

- Phase 14C dedicated suite: **4/4 PASS**.
- Combined Phase 14A/14B/14C + Phase 4 client regression: **22/22 PASS**.
- Phase 5 parity: **9/9 PASS**.
- Existing server regression: **1/1 PASS**.
- Phase 13N-J-B release regression: **10/10 PASS**.
- Production TypeScript build: **PASS**.

The full repository `npm test` run remains a separate gate because the project has existing non-terminating/legacy failures. No partial aggregate pass count is treated as a green release gate.

## Next phase

Phase 14D is the browser Web View application. It must consume this HTTP/client contract and must not introduce browser-specific runtime logic into `src/`.
