# Phase 14F.6 — Live Activity and Reconnection Reliability

## Problem observed

On Android Brave, a foreground prompt could remain at “Starting run” while work was already underway. Reasoning and tool activity appeared only after Stop or a later history refresh. The navigation drawer also showed a generic “Reconnecting…” state and a stale-heartbeat warning even though the runtime API could still be available.

## Root causes

1. The Web View submitted foreground prompts through the JSON-only `prompt()` client method. The HTTP API already supported an SSE response for `POST /prompt`, and `TermAgentClient.streamPrompt()` already existed, but the Web View did not consume it. The browser therefore missed foreground `status`, `reasoning`, `text`, `tool_start`, `tool_end`, and `question` frames while the turn was running.
2. `runtime.runPrompt()` started expensive workspace-context retrieval before publishing any useful activity state. The run was accepted, but the interface had no stage to display during preparation.
3. The browser treated heartbeat age as if it proved the runtime was disconnected. The connection retry loop did not expose its state transitions to the UI, so the drawer could show a generic reconnecting label without telling the user whether the problem was the event stream or the runtime itself.
4. Android/Termux shell permission errors were presented only as raw tool output. This was confusing when the surrounding UI had not shown the tool's start/result lifecycle.

## Upstream adaptation

The implementation was informed by these OpenCode sources:

- `packages/server/src/handlers/event.ts` at the inspected `dev` revision: sends a `server.connected` frame and periodic SSE comment heartbeats on the shared event endpoint.
- `packages/tui/src/mini/stream-v2.transport.ts` at commit `6d1c444b8c53da667b51ed45b0a7c0aca1174674`: models connection attempts explicitly, reconnects the transport, hydrates/reconciles state, and separates transport status from session execution state.
- `packages/tui/src/mini/stream-v2.subagent.ts` at the same commit: consumes child activity from the same event stream rather than starting a second independent runtime.

TermAgent keeps its own HTTP/SSE protocol, durable JSONL event history, session store, and runtime. The adaptation does not introduce OpenCode dependencies or replace the existing transport.

## Changes

### Foreground prompt stream

- The Web View now uses the existing `streamPrompt()` API for foreground prompt turns.
- It consumes status, reasoning, text, tool-start, tool-end, question, heartbeat, done, and error frames as they arrive.
- The direct prompt stream is the authoritative transient projection for a prompt started in that browser tab. Its duplicate process-local EventBus projection is suppressed while the POST stream is active; durable events and snapshot reconciliation remain enabled.
- The run label updates for preparation, thinking, exploration, subagent delegation, terminal commands, editing, verification, permission waits, questions, and response generation.
- A compact live-stage indicator is rendered inline in the transcript as well as in the run bar, so mobile users do not need to open the Activity tab just to see that work is happening.
- Tool failures containing a permission-denied result are explicitly labeled in the Activity timeline. This does not weaken or bypass TermAgent or Android filesystem permissions.

### Earlier runtime activity

- `runPrompt()` publishes the accepted run and “Preparing workspace context” before repository context retrieval.
- Provider turns publish the “Thinking” status before waiting for the first provider stream event. This is a status label, not fabricated model reasoning.
- Tool activity labels are classified for workspace exploration, subagent delegation, editing, shell execution, and verification. Raw tool arguments are not included in the live EventBus activity label payload.
- A Stop during context preparation is checked before the Agent starts, preventing a cancelled preparation step from launching provider work afterward.

### Reconnection state

- `streamEvents()` now reports connecting, connected, reconnecting, and closed transitions through an optional observer callback.
- SSE parsing recognizes LF, CRLF, and CR frame separators, including separators split across transport chunks.
- The browser labels event-stream state separately from server health. It no longer declares a runtime outage solely because a heartbeat is late.
- On a quiet stream, the browser probes the health endpoint and then deliberately replaces the stale SSE reader from the last durable cursor. Failed health checks are reported as server-health failures; healthy server with a quiet/broken stream is treated as an event-stream recovery.
- The foreground prompt SSE endpoint now sends its own 15-second heartbeat frames.

## Permission-denied behavior

A shell command's `Permission denied` output is reported as a failed/denied activity and shown in the timeline. This phase does not auto-approve shell access, alter allow/deny rules, grant Android storage permissions, or suppress the command's error output. The reason for a specific denial must be diagnosed from the actual TermAgent permission decision or shell output; the screenshots alone do not establish which layer denied it.

## Subagent interpretation

The screenshots show zero subagents and a `bash`/`find` tool call. That means no child agent had been created at the time captured. The prompt text mentioning parallel subagents does not itself create children; the model must actually invoke `task`, `background_agent`, or `parallel_agents`. This phase improves the visibility of the activity that is actually emitted but does not force the model to delegate or change tool selection policy.

## Verification

- TypeScript build: passed.
- Web app JavaScript syntax check: passed.
- Focused Phase 14F.6, Phase 14C SDK and Phase 14D Web View tests: 17/17 passed.
- Complete `tests/phase14*.test.mjs` regression group: 75/75 passed.
- Physical Android Brave retest was not available in this environment and remains a device validation item.
- The complete repository-wide `npm test` did not finish within the 240-second execution limit. The partial run logged failures in older agent-churn, `/auto`, undo/redo, and compaction-budget tests; these results are not counted as passing or as Phase 14F.6 regressions. The phase-scoped suite completed successfully.
