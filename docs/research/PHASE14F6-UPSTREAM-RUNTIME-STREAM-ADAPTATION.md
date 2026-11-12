# Phase 14F.6 — Upstream Runtime Stream Adaptation

## Sources inspected

1. OpenCode `packages/server/src/handlers/event.ts` (`dev` branch): its event handler emits an initial `server.connected` event and merges 15-second heartbeat comments with the event feed.
2. OpenCode `packages/tui/src/mini/stream-v2.transport.ts` at commit `6d1c444b8c53da667b51ed45b0a7c0aca1174674`: its transport owns an explicit connection-attempt lifecycle, treats live events as a stream with replay/hydration, and marks reconnection separately from the root session's execution lifecycle.
3. OpenCode `packages/tui/src/mini/stream-v2.subagent.ts` at the same commit: child sessions are reduced from the same shared event stream used by the parent session, with child-specific transcript and blocker hydration.

## Relevant patterns retained

- Explicit transport connection state instead of inferring disconnection from a stale UI timer.
- A heartbeat on the SSE connection, plus durable cursor replay and snapshot reconciliation after a transient gap.
- Distinct transport connectivity and agent execution states.
- Activity projection based on real status, reasoning, tool lifecycle, question, and completion events.
- Shared event stream for parent and child work rather than introducing a second runtime or separate polling agent.

## TermAgent mapping

| OpenCode pattern | TermAgent adaptation |
| --- | --- |
| `server.connected` and heartbeat frame | Existing TermAgent event SSE `ready` and `heartbeat` frames; added heartbeat to foreground prompt SSE as well |
| Stream attempt/reconnect lifecycle | `EventStreamOptions.onConnectionState` in `src/client/client.ts` |
| Root execution status and activity | `runtime.runPrompt()` status/EventBus callbacks and `Agent.onStatus` |
| Provider deltas and tool lifecycle | Existing `POST /prompt` SSE callbacks consumed by `web/app/app.js` |
| Durable replay and snapshot recovery | Existing TermAgent JSONL sequence cursor, replay, gap handling, and snapshot API |
| Parent/child event reduction | Existing TermAgent TaskManager/task-event infrastructure from earlier phases, not duplicated here |

## Intentional differences

TermAgent does not copy OpenCode's schema, Effect runtime, SDK, TUI renderer, or child-session implementation. It preserves its own Node.js/Termux-compatible architecture, typed Fetch client, JSONL durability, EventBus wakeups, and browser Web View. The direct foreground prompt stream supplies prompt-local transient frames; the existing session event stream remains the durable/reconciliation channel.

## References

- https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/event.ts
- https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.transport.ts
- https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.subagent.ts
