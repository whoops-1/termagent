# Phase 14E.1 — Server-owned permission resolver integration

**Date:** 2026-11-01  
**Baseline:** `TermAgent-1.18.0-Phase14D-Hermes-Research-Checkpoint-Full-Source.zip`  
**Scope:** Fix the browser-to-runtime permission resolution path using TermAgent's existing permission gate, session event store, event bus, command API and tool registry.

## Result

Phase 14E.1 is implemented in the supplied source checkpoint copy.

A server-owned `PermissionGate` now waits on the same durable permission interaction that the HTTP/browser API resolves. A browser decision commits through the existing `SessionStore.resolvePermission()` command path. The runtime-local event bus wakes the gate's waiter, which re-reads the durable interaction state and returns the winning decision to the exact `PermissionGate.check()` invocation already awaited by `ToolRegistry.execute()`.

That closes the reported failure mode: the browser no longer only changes a durable record while the original tool execution remains blocked on a separate `readline` prompt. The server runtime installs its requester during composition, so server-owned permission requests do not fall back to `process.stdin`.

## Upstream implementation study and adaptation

The upstream implementations were inspected as behavior references before adapting the existing TermAgent architecture:

- **OpenCode** `packages/opencode/src/permission/index.ts`: associates each pending permission request with its request identity and a deferred decision; the reply path finds that exact pending request and settles the same wait. Pending waiters are finalized/removed when their lifecycle ends. See [OpenCode permission implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts).
- **Cline** `sdk/packages/core/src/hub/server/handlers/approval-handlers.ts`: creates an approval identity, registers a pending resolver before notifying the UI, then resolves the matching approval by identity and removes it before settlement; cancellation drains outstanding approvals. See [Cline approval handlers](https://github.com/cline/cline/blob/main/sdk/packages/core/src/hub/server/handlers/approval-handlers.ts).
- **OpenClaude** `src/grpc/server.ts` from the supplied `openclaude-main.zip`: maintains request-identity-to-resolver callbacks for tool-use approvals, resolves the matching callback on reply, and drains pending requests when the stream ends.

The shared upstream lesson is that a response must settle the original request's wait, not merely update a screen or write unrelated state. TermAgent already has a durable `SessionStore`, first-writer-wins permission resolution, a runtime-local `SessionEventBus`, and `waitForInteractionResolution()`. The adaptation therefore uses those existing primitives rather than copying an ephemeral pending-promise map into the HTTP handler or creating a second approval service. The durable event log remains the source of truth; the bus is only a wakeup mechanism.

## Implementation

### Server requester integration

`src/server/runtime.ts` now installs a requester on the server's existing `PermissionGate`. The requester awaits `store.waitForInteractionResolution(sessionId, requestId, signal)` and maps the durable permission decision back into the existing `once`, `always`, or `deny` contract.

The browser API remains a command adapter. It commits the decision through the canonical store. Once that commit is durable, the bus wakes the waiting runtime. The waiter reads the persisted state and returns it to the still-running permission check. Since `ToolRegistry.execute()` waits at that gate before calling the tool's `execute()` function, the original execution continues on Allow/Once/Always and does not run on Deny.

### First-writer and cancellation behavior

- The durable first-writer resolution is authoritative if browser, terminal-style and cancellation paths race.
- A duplicate or stale resolution cannot overwrite a settled request.
- Requests remain session-scoped; a request ID from another session is rejected.
- `once` is scoped to the current call; `always` persists the existing gate's approval rule; `deny` fails closed.
- An abort, timeout or requester failure durably cancels a still-pending permission with a reason.
- If a durable approval commits in the same wakeup turn as an abort, the committed first-writer decision is observed, but an already-aborted owning turn still cannot start the tool side effect.
- Calls lacking a provider tool-call ID use a fresh random fallback component, preventing concurrent identical direct calls from sharing one permission identity.

`SessionStore.waitForInteractionResolution()` now subscribes before reading, races the bus wakeup against timeout and `AbortSignal`, and re-reads the durable state after a timeout/abort race. `permission.cancelled` projections preserve the cancellation reason. `PermissionGate` consults the durable winner rather than trusting a callback-local proposed decision.

### Graceful shutdown

`runPrompt()` registers its active controller and completion promise before asynchronous context retrieval. Runtime shutdown aborts active runs, waits for their completion (including permission cancellation persistence), and then closes MCP clients.

## Focused verification

`tests/phase14e1-permission-resolver.test.mjs` contains nine tests:

1. Browser Allow resolves the original tool wait; a new browser client instance rehydrates the pending request and resolves it after a simulated reconnect.
2. Browser Deny rejects the original tool wait and prevents tool execution.
3. Terminal-style and browser decisions race through one durable first-writer-wins resolution; stale and wrong-session responses are rejected.
4. The Always decision is durably recorded, and the existing gate grant cache permits a later matching request in the same runtime.
5. Concurrent direct calls without provider tool-call IDs receive independent permission identities.
6. Abort durably cancels the request and prevents execution; a late browser resolution is rejected.
7. Graceful runtime shutdown cancels an in-flight permission, and a newly created runtime reconstructs its settled state.
8. Timeout is enforced even with the event bus enabled and its cancellation reason is persisted.
9. A durable reply wins a simultaneous abort wakeup race, while the gate's post-resolution abort guard still prevents a later tool side effect.

Recorded results:

- `npm run build` — **PASS**.
- `node --test --test-concurrency=1 tests/phase14e1-permission-resolver.test.mjs` — **9/9 PASS**.
- Combined focused Phase 14A–14D + 14E.1 regression set — **36/36 PASS** (`node --test --test-concurrency=1 tests/phase14a-event-interaction.test.mjs tests/phase14b-event-stream.test.mjs tests/phase14c-http-sdk.test.mjs tests/phase14d-webview.test.mjs tests/phase14e1-permission-resolver.test.mjs`).
- `node scripts/verify-dist.mjs` — **PASS**.
- `npm pack --dry-run` — **PASS** (309 package files; 424.5 kB tarball preview).

The repository-wide aggregate `npm test` did **not** complete as a green gate: it encountered an existing failure in `tests/e2e-cli.test.mjs` (`CLI /auto enforces planning, edits, verification, and final completion`, expected `after\n`, actual `before\n`) and the aggregate runner did not terminate before the 240-second limit (output had reached approximately test 313). The same named CLI test was run against the pristine, unmodified checkpoint copy at `/mnt/data/termagent-checkpoint/TermAgent` and reproduced the identical assertion failure. This is a pre-existing baseline failure, not attributed to Phase 14E.1. No full-suite pass is claimed.

No physical Android/Brave device or live-provider end-to-end run was available in this environment. The reconnect test validates durable rehydration through a new API client instance; it is not a physical browser/network interruption test.

## Boundaries and remaining work

Phase 14E.1 is not all of Phase 14E. The following remain open: secure remote bind defaults, device pairing and token lifecycle, Host/Origin validation, CSRF, rate limits, authorization scopes, audit/redaction, and the corresponding security test matrix.

The graceful shutdown test is not a hard-crash recovery test. If the process is killed abruptly, the in-memory Agent continuation is gone and a durable permission event may remain marked pending. Startup must not sweep such requests until Phase 14F has exclusive runtime-owner fencing; otherwise one unfenced process could cancel a request still owned by another live process. After the daemon lease is authoritative, 14F should reconcile orphaned requests from a dead owner as interrupted/cancelled. The terminal TUI also remains an independent local client today; attaching terminal and browser to one daemon is a separate 14F deliverable.

## Files changed

- `src/server/runtime.ts`
- `src/session/store.ts`
- `src/tools/permissions.ts`
- `src/protocol/types.ts`
- `tests/phase14e1-permission-resolver.test.mjs`
- `TODO.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `docs/research/PHASE14E1-UPSTREAM-PERMISSION-RESOLVER-ADAPTATION.md`
