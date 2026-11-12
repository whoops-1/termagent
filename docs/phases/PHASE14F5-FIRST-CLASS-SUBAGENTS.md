# Phase 14F.5 — First-class Subagents workspace

**Status:** Implemented in TermAgent 1.18.0 source.  
**Scope:** Existing agent task execution, durable task/session state, HTTP/SSE, Web View, and daemon-attached terminal.

## Why this phase exists

TermAgent already had specialist roles and child-agent execution through `task`, `background_agent`, and `parallel_agents`. The missing part was an operator-facing workspace. Phase 14F.4 made the terminal and browser converge on task/session state, but the browser still presented child agents as generic tasks. This phase makes the existing child-agent tree a first-class view without replacing the execution engine.

## Design decisions

1. **TaskManager remains the authority.** The tree is projected from durable `TaskRecord` relationships (`parentTaskId`, `parentSessionId`, `childSessionId`, role, depth, status, scope, usage, and activity). No second agent registry or orchestration engine was introduced.
2. **Child sessions remain the transcript authority.** A selected agent's conversation is loaded from its existing child session. The task output remains a separate, bounded diagnostic view.
3. **TaskEventLog remains the activity authority.** Child workers append lifecycle/activity events to their task JSONL log. A task-specific SSE endpoint replays by the durable task sequence and tails detached-worker writes.
4. **Controls use existing TaskManager operations.** Active agents support follow-up instructions and cancellation. Terminal agents support resumption against their saved task/session. There is deliberately no Pause control because the worker runtime has no true pause/resume checkpoint state.
5. **Public projections are allowlisted.** Provider configuration, API keys, worker tokens, permission rules, process identity, raw output tails, raw tool arguments and prompt-bearing event fields do not cross the task-summary/event API.

## Runtime and API changes

### Hierarchical projection

New module: `src/tasks/subagents.ts`.

- `buildSubagentWorkspace(tasks, sessionId)` builds a deterministic parent/child tree from existing task links.
- It only includes `kind: 'agent'` records, associates legacy records by parent/child session when no `parentTaskId` exists, prevents cycles/duplicate nodes, and does not mistake queued siblings sharing the parent's session for nested children.
- The response includes `agents` and status counts (`total`, `queued`, `running`, `completed`, `failed`, `cancelled`).
- `projectTask()` produces a browser/terminal-safe task record. Output is represented by byte count and truncation state rather than an unbounded output field.
- `projectTaskEvent()` produces safe event records by event type. Unknown event payloads are not forwarded automatically.

### Worker activity

`src/tasks/manager.ts` and `src/tasks/worker.ts` now persist bounded activity/progress metadata alongside the existing task state:

- Agent creation and role/parent/delegation metadata.
- Turn start/completion and run count.
- Tool start/completion with tool identity and outcome, not raw arguments.
- Current activity label, elapsed duration, output byte checkpoints, and usage totals when the provider reports them.
- Final output checkpoint even for a short worker run that finishes before the progress throttle fires.

The worker continues to use the pre-existing specialist allowlists, scope checks, permission derivation, task queue and child session lifecycle.

### HTTP endpoints

- `GET /api/v1/sessions/:sessionId/subagents` — session-scoped hierarchical workspace.
- `GET /api/v1/tasks/:taskId` — safe task projection.
- `GET /api/v1/tasks/:taskId/events?limit=&after=` — sanitized task activity history; supports bounded tail or sequence pagination.
- `GET /api/v1/tasks/:taskId/events/stream?after=` — task-event SSE replay and tail, with `ready`, `connection`, heartbeat and event frames.
- `GET /api/v1/sessions/:sessionId/messages?after=&limit=&tail=1` — bounded child-transcript tail without transferring the entire conversation on each detail refresh.

Task and session authorization is checked before task data is returned or an SSE stream is opened. Device authorization is rechecked during the stream heartbeat. The task event JSONL is authoritative because the worker is detached and does not share the server process's in-memory event bus. The stream therefore polls the durable task log at 500 ms for new entries, uses the existing SSE writer/backpressure behavior, and resumes from the last event sequence after reconnect.

### Web View

Files: `web/app/index.html`, `web/app/app.js`, `web/app/styles.css`.

- Added a dedicated Subagents entry and active agent count.
- Shows nested agent cards with role, state, task identity, prompt, duration, recent activity, token usage/run count, and allowed workspace scope.
- Detail view separates execution metadata, child conversation, lifecycle timeline, and task output.
- Active agents accept follow-up instructions and cancellation. Completed/failed/cancelled agents expose continuation through the existing resume path.
- Detail subscribes to durable task SSE and coalesces event-triggered refreshes; a slower 7.5-second reconciliation refresh repairs state after browser sleep/proxy drops. The list uses a 1.8-second refresh while open.
- Requests are bounded: 120 timeline events, 24 KB of output, and 14 recent child messages. The timeline renders the most recent 24 events.
- Request identity guards prevent late responses from a previously selected task/session from overwriting the currently open detail view.
- Layout has a responsive card/tree and detail treatment for narrow screens. No second design system was introduced.

### Daemon-attached terminal

`src/cli/daemon-client.ts` now provides:

- `/subagents` — tree and summary view for the active session.
- `/subagents <task-id>` — bounded detail view with child transcript, lifecycle and output.
- `/subagent-send <task-id> <message>` — queue a follow-up instruction for an active child.
- `/subagent-resume <task-id> <message>` — continue a terminal child task using its existing identity/session.
- Existing `/cancel [task-id]` remains the cancellation path.

Commands are included in daemon-terminal help and completion. Task references are resolved only within the active session's subagent tree.

## Verification

The implementation was verified with:

- `tsc -p tsconfig.json` — passed.
- `node --check web/app/app.js` — passed.
- `node --test --test-concurrency=1 tests/phase14f5-subagents.test.mjs` — 4/4 passed. Includes an actual authenticated task-event SSE stream test and a real worker run against a local mock OpenAI-compatible SSE endpoint.
- Focused regression batch covering existing task execution, Phase 14A–14F.4, and Phase 14F.5 — 81/81 passed.
- `node scripts/verify-dist.mjs` — passed.
- `node dist/index.js --version` — returned `1.18.0`.
- `npm pack --dry-run` — passed and included the generated `dist/tasks/subagents` module, client/protocol/server changes, and Web View assets.

The complete `npm test` run did not finish within the 240-second command limit. It reported the `/auto` CLI E2E assertion (`before\n` remained instead of the expected `after\n`). This specific failure was reproduced unchanged against the Phase 14F.4 source archive's `tests/e2e-cli.test.mjs` (4/5 passed there, with the same `/auto` failure), so it is not introduced by this phase. The targeted 81-test regression batch completed successfully; this is not represented as a clean full-suite run.

No physical Android browser/terminal session was available for this verification. Browser JavaScript syntax, server/API behavior, authenticated SSE delivery, and static Web View integration were tested in the local Node environment.

## Files of interest

- `src/tasks/subagents.ts`
- `src/tasks/manager.ts`
- `src/tasks/worker.ts`
- `src/protocol/api.ts`
- `src/server/api.ts`
- `src/server/http.ts`
- `src/client/client.ts`
- `src/cli/daemon-client.ts`
- `web/app/index.html`
- `web/app/app.js`
- `web/app/styles.css`
- `tests/phase14f5-subagents.test.mjs`

## Upstream implementation references

See [`PHASE14F5-UPSTREAM-SUBAGENT-ADAPTATION.md`](../research/PHASE14F5-UPSTREAM-SUBAGENT-ADAPTATION.md) for the reviewed upstream files and the exact adaptations.
