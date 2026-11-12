# Phase 14F.5 — Upstream subagent implementation adaptation

## Research rule

This phase follows the project rule: inspect existing upstream implementations first, understand their data flow and lifecycle, then adapt the relevant pattern to TermAgent's current architecture. It does not create a replacement agent runtime or copy another product's whole UI stack.

## OpenCode: child sessions, live tracking and transcript hydration

Repository: `anomalyco/opencode`  
Reviewed commit: `6d1c444b8c53da667b51ed45b0a7c0aca1174674`.

Primary files reviewed:

- [`packages/tui/src/mini/stream-v2.subagent.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.subagent.ts)
- [`packages/tui/src/mini/stream-v2.transport.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/stream-v2.transport.ts)
- [`packages/tui/src/mini/types.ts`](https://github.com/anomalyco/opencode/blob/6d1c444b8c53da667b51ed45b0a7c0aca1174674/packages/tui/src/mini/types.ts)

### Observed implementation

OpenCode treats a subagent as a child session and links it to the parent session. The mini TUI tracker discovers children from projected subagent tool output, parent IDs in the session list, active-session state and live events arriving from sessions that have not yet been discovered. It keeps a child state per session, buffers events during discovery/hydration, rebuilds transcript frames from projected messages on selection/reconnect, and continues from the shared live event stream. It bounds family size, discovery concurrency, child message/frame buffers and pending event queues. Tool lifecycle is correlated by stable message/part IDs. Child permissions/forms are hydrated separately and reconciled with events that arrive during lookup. Per-child interruption is supported by the child session API.

The important design insight is that the subagent view is a projection of the existing parent/child session family, not a second independent execution manager. Discovery and transcript hydration are deliberately separate so a user can navigate between parent and child while the underlying session stream remains shared.

### TermAgent adaptation

TermAgent's child work already has a durable `TaskRecord` as well as an optional child `SessionStore` transcript. Its relationships are `parentTaskId`, `parentSessionId`, `childSessionId`, and delegation depth. Therefore Phase 14F.5 does not recreate OpenCode's process-local `ChildState` tracker as a new domain authority.

Instead, it adapts the relevant concepts as follows:

| OpenCode pattern | TermAgent adaptation |
| --- | --- |
| Parent/child session family | Projected TaskManager task graph, with existing parent task/session and child session IDs |
| Child discovery and cycle protection | Deterministic graph projection with visited-set and scope validation |
| Transcript reconstruction on child selection | Bounded recent-message read from the existing child SessionStore session |
| Same event stream for parent and child | TaskEventLog-backed task-specific SSE because detached worker processes cannot share the server's in-memory EventBus |
| Stable tool/message identity | Existing worker task event identity (`callId`, task ID and monotonically increasing JSONL `seq`) |
| Per-child interrupt | Existing TaskManager cancellation; no unsupported pause control is shown |
| Bounded child queues and frames | Bounded API pages/output/transcript/timeline and coalesced UI refreshes |

OpenCode's `stream-v2.subagent.ts` is a TUI-side detail tracker over its own event/schema model. Porting that module directly would duplicate state in TermAgent, so only the data-flow, reconciliation and bounded-tracking principles were adapted.

## OpenClaude: retained teammate transcript and task detail

User-provided archive reviewed: `openclaude-main.zip`, package `@gitlawb/openclaude` version `0.31.0`.

Files reviewed:

- `src/state/teammateViewHelpers.ts`
- `src/components/tasks/InProcessTeammateDetailDialog.tsx`
- `src/tools/TaskOutputTool/TaskOutputTool.tsx`
- `src/tools/TaskListTool/TaskListTool.ts`

### Observed implementation

OpenClaude distinguishes a teammate task from a generic process task. Its view helper enters and exits a teammate transcript view, retains the selected local-agent transcript while it is being viewed, releases previous selections when switching, and evicts terminal transcript state after a grace period. Its detail dialog shows identity/role, status, current activity, prompt, elapsed duration, token count and tool-use count. It provides task-specific controls only where that execution type supports them, such as kill or foreground operations.

### TermAgent adaptation

TermAgent's child transcript is persistent in SessionStore, so it does not need OpenClaude's in-memory `retain` flag or transcript eviction machinery. The equivalent operator experience is supplied by a dedicated detail view that reads the child session's recent messages, keeps task activity and output in separate sections, and navigates back to the parent tree. TermAgent's existing task controls are follow-up/send, cancel and resume. Pause/foreground are not shown because the TermAgent worker contract does not implement those states.

## Why the integration is not a wholesale port

- OpenCode uses its own session/client schema and a terminal mini transport. TermAgent's canonical unit for delegated work is a durable task linked to a child session.
- OpenClaude's teammate panel runs inside its own application state and React/Ink component model. TermAgent's browser is a server-rendered HTML/JS client over the existing authenticated API.
- TermAgent already has TaskManager, TaskEventLog, TaskWorker, SessionStore, specialist policy, worker permissions and cross-client daemon APIs. Duplicating these would create two competing sources of truth.
- The resulting UI is intentionally built on the current TermAgent Web View design tokens and daemon command model.

## Resulting architecture

```text
Existing parent Agent / tools
       |
       +-- task / background_agent / parallel_agents
                    |
                    v
        Existing TaskManager records
        parentTaskId / parentSessionId
        childSessionId / specialistRole
                    |
             +------+------+
             |             |
             v             v
        TaskWorker      SessionStore
             |          child transcript
             v
        TaskEventLog
        append-only JSONL
             |
             v
      task-events SSE API
      replay by task seq
             |
        +----+-----+
        |          |
        v          v
     Web View   Daemon terminal
     tree/detail shared task tree
     controls    /subagents commands
```

The TaskManager/TaskEventLog/SessionStore remain authoritative. Web View and terminal are clients and project the same records.
