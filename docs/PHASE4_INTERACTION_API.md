# Phase 4: Interaction and API Surface

Phase 4 completes the main user-facing interaction layer and turns the existing runtime into a reusable local service.

## Terminal interaction

the relevant TermAgent subsystem owns logical prompt state. the relevant TermAgent subsystem owns terminal presentation. the relevant TermAgent subsystem owns command dispatch and session coordination.

### Prompt history

`/history [query]` opens bounded history search. `Ctrl+R` opens the same selection model without mutating the current draft until an entry is accepted.

### Draft editing

`Ctrl+Z` and `Ctrl+Y` undo and redo prompt edits. The editor keeps a bounded edit history and resets that local history when a replacement draft is loaded from stash or an external editor.

### Vim mode

`/vim` toggles Vim-style prompt editing. Insert and normal modes are explicit state. The supported normal-mode subset includes motion, deletion, line operations, and insert entry points.

### External editor

`Ctrl+G` edits the current draft externally. `/editor` opens a fresh draft. `$VISUAL` takes precedence over `$EDITOR`; when neither is configured, TermAgent uses a platform default editor. Editor commands are parsed into executable plus arguments and launched without a shell.

`/export` writes the current conversation to a temporary Markdown document and opens it with the same editor path.

### Stash and queue

`Ctrl+S` stashes the current draft. `/stash`, `/stash list`, and `/stash clear` manage the persisted draft.

`/queue <prompt>` adds a prompt to the durable project-local queue. `/queue` lists queued prompts and `/queue clear` removes them. Queued prompts run automatically after the active turn finishes.

Draft state is stored outside the project tree and protected by a cross-process lease plus atomic replacement.

### Tool and diff presentation

`/details` toggles expanded tool output. Tool execution records include start time, duration, and metadata while the default terminal view remains compact.

`/diff` reports file-level additions/deletions and bounded patch text. Binary changes are identified without attempting to render binary payloads.

## HTTP API

The server uses Node's standard HTTP module and JSON/SSE responses. Authentication is optional and localhost is the default bind target.

Session event streaming is available at:

```text
GET /api/v1/sessions/:id/events/stream?after=N
```

It emits a `ready` event, then persisted session events with their current offset. Heartbeats are sent while idle.

Prompt streaming emits:

```text
reasoning
text
tool_start
tool_end
done
error
```

Only provider-supplied explicit reasoning is forwarded. The service does not manufacture hidden reasoning content.

Session status can be read while a prompt is executing:

```text
GET /api/v1/sessions/:id/status
```

An active prompt can be interrupted with:

```text
POST /api/v1/sessions/:id/interrupt
```

Concurrent session prompts are rejected with HTTP 409 rather than being silently interleaved.

## Client SDK

The dependency-free JavaScript SDK is exported at `termagent/client` and wraps sessions, event streams, tasks, models, agents, skills, tools, diffs, undo/redo, interruption, and prompt execution.

Streaming calls accept an optional `AbortSignal` and cancel the underlying response reader when the iterator is closed.

## Process boundaries

Terminal UI state remains local to a client process. Durable task and draft state is file-backed and synchronized with filesystem leases, so separate TermAgent processes can safely share a project queue or task registry.

## Portability

No runtime dependency was added for Phase 4. The implementation remains based on Node.js standard APIs and ANSI/VT terminal controls so ARMv7 Termux remains a supported target.
