# Phase 14F.4 — Upstream client state projection research and adaptation

**Research date:** 2026-11-03  
**Target:** TermAgent 1.18.0 Phase 14F.3 checkpoint.

## Scope

This research focused on how an established terminal client reconstructs and updates a session transcript from streamed events, especially when multiple tool calls have the same visible name, and how a CLI attaches to a daemon-owned runtime. It was not a general redesign of TermAgent's event protocol.

## OpenCode implementation reviewed

### Tool-call keyed stream reconciliation

Reviewed:

- [`packages/tui/src/mini/stream-v2.transport.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.transport.ts)
- [`packages/tui/src/mini/stream-v2.subagent.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.subagent.ts)

The transport maintains keyed tool state and reconciles lifecycle/progress/output by stable message and part/tool identity. Its state machine separates start, progress and final phases and avoids assuming that tool name uniquely identifies a call. That matters for parallel calls to the same tool and for replay/stream overlap.

**TermAgent adaptation:** use the existing provider `call.id` / `tool_call_id` as the stable key in the terminal transcript. Hydration reconstructs assistant tool calls and joins the matching tool result; live callbacks and durable lifecycle events update the same entry. TermAgent keeps its own `Entry` / `StreamCommit` presentation types and does not import OpenCode's TUI transport, schema package or renderer.

### Event subscription and connection semantics

Reviewed:

- [`packages/protocol/src/groups/event.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/protocol/src/groups/event.ts)
- [`packages/server/src/handlers/event.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/server/src/handlers/event.ts)
- [`packages/client/src/solid/connection.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/client/src/solid/connection.ts)
- [`packages/cli/src/acp/sessions.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/cli/src/acp/sessions.ts)

The inspected client code subscribes before the initial state read/attach in flows where an update between those operations could be missed. Connection code treats `server.connected` as a stream readiness marker and owns reconnection/abort lifecycle explicitly. These patterns informed the review of TermAgent's existing subscribe/snapshot/replay order; the F4 implementation did not replace the Phase 14F.2 durable cursor and snapshot-gap model.

### Daemon/client separation

Reviewed:

- [`packages/cli/src/services/server-connection.ts`](https://github.com/anomalyco/opencode/blob/3ba597f7769e19cc3b5f67e3d6667e7b6318f6a3/packages/cli/src/services/server-connection.ts)
- [`.opencode/skills/opencode-dev/SKILL.md`](https://github.com/anomalyco/opencode/blob/3ba597f7769e19cc3b5f67e3d6667e7b6318f6a3/.opencode/skills/opencode-dev/SKILL.md)

The architectural guidance makes the server the owner of application/runtime state and the TUI an HTTP/SSE client. Managed service discovery probes the registration and verifies the live server identity before reuse; explicit standalone mode is separate. Phase 14F.3 adapted that separation to TermAgent's exclusive workspace lease and `TermAgentClient`.

## Adaptation boundaries

| Upstream principle | TermAgent adaptation | Deliberately not copied |
|---|---|---|
| Tool-part/call keyed state | Stable `callId` in `TerminalUI` and daemon event projection | OpenCode's mini-TUI renderer, schema packages and commit vocabulary |
| Lifecycle phase reconciliation | TermAgent's durable `session.tool.*` events plus transient activity callbacks | A second event schema or transport layer |
| Subscribe/reconnect lifecycle | Retain TermAgent's existing `TermAgentClient` SSE cursor, gap and snapshot reconciliation | An additional WebSocket or shared client event bus |
| Daemon owns Agent runtime; terminal is client | Existing owner lease, HTTP/SSE command API and daemon queue worker | Replacing TermAgent's runtime/session store with OpenCode packages |
| Stable identity across permission waits | Persist existing provider tool call ID on interaction request projection | A second permission promise registry or tool-name matching as authority |

## Additional design conclusion: non-interactive observers

A daemon-attached terminal without a TTY cannot display an interactive permission/question prompt. Automatically rejecting or cancelling that interaction from a passive process would let one client silently decide on behalf of another. TermAgent therefore leaves the durable interaction pending when the attached terminal cannot render an interaction UI. A browser/interactive client can resolve it through the existing durable first-writer-wins API.

This is an explicit TermAgent safety rule derived from the single-owner/multi-client architecture; it is not represented as a copied OpenCode feature.

## Source-of-truth and limitations

The code references above establish upstream patterns, not test evidence for TermAgent. TermAgent's own focused tests are recorded in `docs/phases/PHASE14F4-CROSS-CLIENT-STATE-CONVERGENCE.md`. The current phase does not prove full multi-client TTY parity, mobile browser behavior or daemon crash recovery with multiple connected interactive clients.
