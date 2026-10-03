# Phase 13G — Tool-call lifecycle and provider-turn settlement

## Status

**Implemented and verified.** Phase 13G makes the provider execution loop explicit about turn boundaries and settlement. Each provider turn records its boundary, every tool call receives durable lifecycle state, local calls settle before continuation, the next provider request is rebuilt from durable history, and abandoned calls become explicit interrupted state.
Implementation design:

- the implementation the relevant TermAgent subsystem: one provider turn, eager local tool settlement, durable tool outcomes, waiting for all local settlements before continuation, interruption cleanup, provider-hosted tool distinction, and the explicit continuation loop.
- the implementation the relevant TermAgent subsystem: stable call identity, duplicate detection, typed pending/called/settled tool state, provider metadata, explicit failed/success outcomes, and failure of unsettled calls on provider interruption/error.
- the implementation the relevant TermAgent subsystem: session loop/turn boundaries and the rule that provider turns containing tool calls continue through another durable-history request rather than terminating at the provider's `tool_calls` finish reason.
- the implementation the relevant TermAgent subsystem: pending/running tool parts must be represented as explicit tool-call state and abandoned/interrupted calls must not remain as phantom work.
- the implementation the relevant TermAgent subsystem: per-tool execution tracking, bounded parallel execution, deterministic result emission order, sibling cancellation, synthetic interruption results, and duplicate/invalid streamed tool lifecycle checks.
- the implementation the relevant TermAgent subsystem and the relevant TermAgent subsystem: lifecycle assertions, abort propagation, and clearing active operation state after settlement.

## TermAgent changes

### Provider-turn boundaries

the relevant TermAgent subsystem now records a `provider.turn` event for each round with explicit `started`, `tool_settling`, `completed`, `error`, and `interrupted` states.

The turn flow is:

1. Build the provider request from the current message state.
2. Stream exactly one provider turn.
3. Normalize all tool call IDs before local dispatch.
4. Persist each tool call as `pending` before execution.
5. Settle provider-hosted calls from provider results without dispatching them through the local registry.
6. Execute local calls with per-tool lifecycle transitions.
7. Persist tool results through the normal message path and ToolOutputStore projection.
8. Reload durable turn history before the next provider request.
9. Continue only when the provider turn actually produced tool work requiring another model turn.

### ToolCallLifecycle

Added/strengthened the relevant TermAgent subsystem.

Each record carries:

- session ID
- provider turn ID
- stable tool call ID
- tool name
- raw arguments
- parsed arguments when valid
- lifecycle state
- lifecycle outcome
- provider-executed flag and provider metadata
- execution metadata
- persisted tool-output reference/path when available
- start/end timestamps
- terminal error text

Supported states are `pending`, `running`, `completed`, `error`, and `interrupted`.

Explicit outcomes include successful execution, generic tool failure, permission denial, question rejection, interruption, and provider-hosted execution.

Duplicate provider call IDs are rejected before local dispatch. Durable lifecycle records also defensively reject duplicate session/turn/call keys.

### Concurrency and deterministic settlement

Independent tools marked `parallelSafe` execute concurrently with a bounded batch size of four. Their provider-facing tool results are appended in the original provider call order, even when execution completion order differs.

This keeps latency benefits from concurrency without making transcript ordering nondeterministic.

### Error and permission state

Malformed tool arguments produce an explicit lifecycle `error` state and never execute the tool.

Permission denials and rejected interactive questions are classified into explicit lifecycle outcomes rather than being indistinguishable from ordinary execution failures.

### Cancellation and recovery

When the provider turn is interrupted, any pending/running calls for that turn are transitioned to `interrupted` and the `provider.turn` event is also marked `interrupted`.

On session recovery, previously abandoned pending/running lifecycle records are converted to interrupted terminal records. Recovery now also refreshes the in-memory lifecycle snapshot so stale running state cannot survive in the current runtime.

The external `AbortSignal` reason is forwarded into TermAgent's turn controller, and the listener is removed when the turn settles.

### Provider-hosted tools

A call marked `providerExecuted` is resolved from the provider's own `tool_result` event and never dispatched through `ToolRegistry`. Its lifecycle remains separately recorded as `provider_hosted`.

### Loop protection

Existing tool-loop protection is now explicitly integrated at the tool-call boundary. Repeated identical tool name + arguments are blocked after the configured threshold, with a user confirmation escape hatch for deliberate repetition outside autonomous mode.

## Verification

- TypeScript build: **PASS**
- Phase 13G dedicated suite: **15/15 PASS**
- Phase 13A–13G targeted regression matrix: **82/82 PASS**
- Broader agent/context/execution/provider compatibility sweep: **88/88 PASS**

The historical aggregate `npm test` runner stall remains a separate archive issue and is not counted as a Phase 13G failure or success.

## Files
- `tests/phase13g-tool-lifecycle.test.mjs`
- `docs/phase13/tool-inventory.json`
- `docs/PHASE13G-REPORT.md`
- `TODO.md`

## Deliberate boundaries

- Rich resource-specific shell approval remains under the later Phase 13K permission work.
- Child-task/session unification belongs to Phase 13I.
- Staged micro-compaction and machine-owned context epochs remain Phase 13H.
- The existing TaskManager remains authoritative for background task runtime state; `ToolCallLifecycle` records provider-turn tool execution truth separately.
