# Phase 14F.4 — Cross-client state convergence

**Status: implemented, host-verified partial sub-gate. Phase 14F remains open.**  
**Baseline:** TermAgent 1.18.0, Phase 14F.3 daemon-client checkpoint.  
**Date:** 2026-11-03.

## Objective

Make the attached terminal a useful peer of the Web View over the existing single-owner daemon. This slice closes several concrete state-projection gaps without introducing a second runtime, another event transport, or a parallel state store.

The canonical architecture remains:

- the workspace daemon owns Agent turns, tools, permissions, questions, queues, tasks, checkpoints and session writes;
- the existing HTTP/SSE `TermAgentClient` is the terminal's remote boundary;
- durable SessionStore events/snapshots are authoritative;
- transient SSE activity is presentation feedback and may be repaired from durable history;
- standalone REPL remains available when there is no daemon owner.

## Implementation

### 1. Tool-call identity and transcript reconstruction

`TerminalUI.hydrate()` now reconstructs assistant tool calls from saved `tool_calls` and associates tool-role result messages through `tool_call_id`. A hydrated tool result updates the matching call entry rather than creating a duplicate row.

The live tool UI carries the provider call ID through `startTool`, lifecycle updates and `endTool`. Lifecycle projection supports `pending`, `running`, `completed`, `error` and `interrupted`. If two tools have the same display name, their independent call IDs prevent one result from closing the other tool's row. The existing name-based fallback remains for legacy events which have no call ID.

Call IDs are now carried through Agent → runtime → API/SSE callbacks. `SessionStore` already persisted tool lifecycle records by call ID; the terminal adapter now uses those identities consistently for live and reconstructed state.

### 2. Permission-to-tool association

Permission requests now persist the source provider `toolCallId` with their durable interaction event/state. The reconstructed `PermissionRequestState` exposes that ID after reconnect. When the terminal shows a remote permission request, the UI marks and resolves the exact tool call that requested it instead of guessing from the latest active tool or matching only by name.

This is an association improvement, not a new permission resolver. Resolution still uses the Phase 14E.1 durable first-writer-wins path.

### 3. Passive terminal clients do not hijack browser interactions

A non-interactive attached terminal has no terminal permission/question modal. It is therefore a passive observer for those interactions. It no longer auto-denies a permission or cancels a question simply because `stdin` is not a TTY or a UI cannot be rendered.

Interaction resolver bookkeeping now only marks a request finished once a durable resolution is confirmed, or the request is verified to have left pending state. Transient network/command failures leave the request retryable and schedule a later synchronization attempt. This protects browser-owned interactions when a passive process is also attached.

### 4. Daemon-owned state projection

The daemon client now handles the existing durable event families for tool lifecycle, Todo updates, task creation/update/notification, workflow progress, verification, workspace mutation, diff invalidation, provider turn status, context checkpoints, checkpoint creation/restoration, compaction, queue changes and history undo/redo.

The client requests canonical snapshots or resource details where an event is an invalidation/notification rather than a complete state object. Durable assistant messages remain the repair path when streamed assistant text is incomplete or differs from the saved final message.

### 5. Attached-terminal command coverage

Added attached-mode commands using existing API operations:

- `/diff [staged]`
- `/tasks`, `/task-log <id>`, `/task-output <id>`
- `/cancel [task-id]` and `/interrupt`
- `/checkpoint [label]`, `/checkpoints`, `/restore <checkpoint-id>`, `/branch <checkpoint-id>`

`/cancel` without an argument preserves its existing current-session interruption behavior. `/interrupt` is the explicit current-turn operation. Task ID resolution accepts exact IDs or unambiguous prefixes and reports ambiguous matches. Branch activation uses the returned child session from the existing checkpoint API.

The command catalog is still not a complete mirror of standalone REPL administration commands. Provider/model/plugin/marketplace/theme/skills management and other advanced utilities remain deferred.

## Verification

Commands run from the project root:

```bash
tsc -p tsconfig.json --pretty false
node --test --test-concurrency=1 tests/phase14*.test.mjs
node scripts/verify-dist.mjs
node dist/index.js --version
node --check web/app/app.js
npm pack --dry-run
```

Results:

- TypeScript production build: **PASS**.
- Focused Phase 14 suite: **66/66 PASS** (includes the Phase 14A–14F.3 coverage and the new F4 regressions).
- Release distribution verification: **PASS**.
- Packaged CLI version: **1.18.0**.
- Web View JavaScript syntax: **PASS**.
- npm package dry-run: **PASS**, 317 package files.

The focused Phase 14 suite is not the repository-wide suite. The known `/auto` CLI integration failure and prior aggregate timeout are not reclassified as fixed by this sub-gate. No full `npm test` pass is claimed.

## Remaining Phase 14F work

This sub-gate does not establish complete TTY/browser parity. Still required:

1. Interactive terminal permission and question decisions must converge with browser decisions on physical TTYs, including the losing side of conflicting responses.
2. Exercise two browser clients plus an attached terminal against one active run, including duplicate commands, queue edits, session switching and cancellation races.
3. Exercise client attach/detach, network interruption, reconnect during streaming, daemon crash/restart with active clients, and stale-owner recovery with real child processes.
4. Verify live tool output, task events, permission/question modals, Todo, diffs and checkpoint history in actual terminal and browser renderers, not just state/API tests.
5. Test on Android/Termux with Brave/Chrome, including background/foreground and network handoff.
6. Close the repository-wide regression gate and gather the Phase 14 performance measurements already listed in `TODO.md`.

Phase 14F remains OPEN. WebSocket remains deferred; this work continues to use HTTP/SSE plus durable reconciliation.
