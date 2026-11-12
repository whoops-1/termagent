# Phase 14C — HTTP API and Dependency-Free Client SDK

## Scope

Phase 14C turns the canonical TermAgent session/runtime contract into a stable HTTP surface and a dependency-free JavaScript client. This phase does not add the browser application. The terminal runtime, durable session store, and Phase 14B event bus remain authoritative.

## Upstream research

### OpenCode

Research covered the pinned Phase 13 revision `7945de208964a49300d7f770d1a71d078db9a4c4` plus the current V2 session/SDK contract where the pinned layout has moved.

Relevant implementation families:

- `packages/opencode/src/session/processor.ts` — semantic session/tool event processing.
- `packages/core/src/tool/*` and the process layer — runtime services are separated from HTTP/UI concerns.
- `packages/opencode/src/server/routes/instance/httpapi/*` and `packages/protocol/src/groups/*` — route contracts are declared separately from handler logic.
- `packages/client/src/generated/client.ts` and `packages/sdk/js/src/v2/gen/sdk.gen.ts` — typed, dependency-light client request surfaces.
- `specs/v2/session.md` and `CONTEXT.md` — durable session events are the replay/recovery contract; client reconnection is explicit composition over durable sequence cursors.

The important adaptation is not code copying. TermAgent keeps its own route IDs, protocol names, Node HTTP transport, JSONL SessionStore, and zero-runtime-dependency browser client.

### OpenClaude

The pinned OpenClaude material was used as a secondary reference for the existing bridge/reconnect and client-facing session-state model. The Phase 14C design keeps the same principle already established in TermAgent: clients observe semantic session state and submit semantic commands rather than scraping terminal output.

### LaudaCode

The pinned LaudaCode process/task implementation reinforces the separation between runtime-owned task/process state and presentation. TermAgent therefore exposes task state as API data rather than leaking internal worker handles into HTTP responses.

## Architecture

```text
HTTP request
    -> auth + body/path decoding
    -> canonical protocol validation
    -> server API adapter
    -> SessionStore / CommandLedger / Queue / TaskManager / Runtime
    -> durable event + projected result
    -> HTTP response

Web View / other consumer
    -> dependency-free TermAgentClient
    -> fetch + JSON / fetch-based SSE
    -> EventEnvelope / CommandEnvelope
```

`src/server/http.ts` owns transport concerns only: HTTP status/headers, authentication, JSON limits, path/query decoding, SSE framing, and conversion into canonical commands. `src/server/api.ts` is the service adapter and delegates to existing runtime services. It does not create a second session or execution model.

`src/protocol/api.ts` contains stable public route and data contracts. `src/protocol/types.ts` remains the canonical semantic event/command model. `src/client/client.ts` depends only on those protocol modules and browser/Node-standard Fetch APIs.

## HTTP surface

The public V1 surface covers server health/info/status, session discovery/creation, session history/messages/events/event streaming/status/diff/context/snapshot, pending permission/question state and resolution, Todo/queue, checkpoints, tasks and task output/events, prompt/command submission, and provider/model/agent/skill/tool discovery.

The preferred synchronization sequence is:

1. Fetch an authoritative session snapshot/history.
2. Record the durable sequence.
3. Subscribe to the durable event stream from that sequence.
4. Apply durable events in sequence order.
5. Use the snapshot again when a client misses live-only fragments or detects a reconciliation condition.

## SSE client behavior

The client deliberately does not use browser `EventSource`. Fetch is used so `Authorization` and other explicit headers work consistently.

The reader is incremental and supports:

- multiline `data:` fields,
- fragmented transport chunks,
- JSON frame decoding,
- durable cursor advancement from event envelopes,
- reconnect after a normal or failed stream termination,
- exponential retry backoff with an abort signal.

A reconnect request uses the latest durable sequence observed by the client. Live-only events never advance that durable cursor.

## Idempotency and stale commands

Commands are sent as `CommandEnvelope` objects containing `commandId`, `clientId`, `sessionId`, timestamp, optional expected sequence/revision, command kind, and payload. The existing `CommandLedger` remains the authority for duplicate delivery, idempotency conflicts, and stale expected-state checks.

Permission and question resolution continue to use the existing durable first-writer-wins state transitions.

## Route drift prevention

`API_ROUTES` is the single declared public route inventory. The client exports `CLIENT_ROUTE_IDS`, and the Phase 14C regression suite requires these inventories to remain identical and route IDs/path-method pairs to remain unique. This catches the class of mismatch where a client route exists in protocol declarations but the server still exposes only an older compatibility alias.

One such mismatch was found during implementation: the stable checkpoint-create route is plural (`POST /api/v1/sessions/:sessionId/checkpoints`) while the legacy server alias was singular. The stable route was added and the singular alias was retained for compatibility.

## Verification boundary

Phase 14C focused tests cover route/schema drift, dependency-free client imports, auth headers, fetch-based SSE, cursor-based reconnect, real HTTP session/runtime surfaces, durable permission/question resolution, command idempotency, checkpoints, tasks, and the pre-existing Phase 14A/14B stream semantics.
