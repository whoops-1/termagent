# Phase 14F.1 — Exclusive runtime ownership and restart reconciliation

**Date:** 2026-11-01  
**Status:** Implemented and host-verified; Phase 14F remains open.

## Scope

This is the first bounded implementation slice of Phase 14F. It establishes the single-runtime-owner invariant and restart-state reconciliation. It does not yet convert the terminal UI into a daemon client.

## Implementation

### 1. Workspace-scoped owner lease

Added `src/server/daemon-owner.ts`.

- Server and standalone terminal entry points acquire the same workspace-keyed lease before creating their runtime.
- Canonical workspace paths are hashed to separate state for independent projects.
- Owner creation uses exclusive file creation; a second process gets a clear message naming the owner mode, PID and Web View endpoint when known.
- Owner records include random instance and lease identities, PID, Linux process-start identity where available, mode, start time, state, endpoint and heartbeat time.
- POSIX state directories and owner records use `0700` and `0600` respectively.
- Stale owner recovery uses a recovery guard and revalidates the observed owner identity before unlinking. PID reuse is distinguished with `/proc/<pid>/stat` when available; inability to establish that a possibly-live process is stale fails closed.
- Release compares the current lease token before removing files, preventing an old owner from deleting a successor's lease.

### 2. Server lifecycle and discovery

`src/server/index.ts` acquires ownership before `createRuntime()`, records the ready HTTP/Web View endpoint and releases the owner after server and runtime shutdown. The HTTP server exposes an explicit `termagent.shutdown()` lifecycle method. Shutdown closes active HTTP connections before awaiting runtime cleanup so persistent SSE clients cannot hold the lease indefinitely. The existing `/health` response now includes a safe `daemon` projection: instance ID, workspace hash, PID, mode, state, start time, heartbeat time and optional endpoint. Lease tokens and full workspace paths are not returned.

`readDaemonOwner()` provides local owner discovery from the private registration record and returns only a matching live owner.

### 3. Terminal single-owner guard

`src/cli/repl.ts` acquires the same workspace lease before migration, session loading, task recovery or runtime construction. Therefore starting `termagent` while `termagent --serve` owns that workspace fails clearly rather than creating a second Agent/PermissionGate/TaskManager/EventBus.

This is intentionally transitional: terminal attachment to the existing server will be implemented in a following 14F slice. The current TUI is not yet a daemon client, so simultaneous terminal + browser use is not claimed.

### 4. Hard-crash reconciliation

After the exclusive lease has been acquired, the runtime scans session logs for that workspace and:

- Cancels orphaned pending permissions with `cancelReason: daemon-restart`.
- Cancels orphaned unanswered questions with an explicit daemon-recovery command/client identity.
- Marks unmatched `started` turn records as `interrupted`, with the recovering owner ID and timestamp.
- Adds the durable `session.turn.interrupted` event kind and surfaces it to Web View refresh reconciliation.

This path is not called by tests or code that creates an unfenced runtime directly. The recovery operation never runs before the new owner lease is acquired, and it never converts an unfinished turn into a successful one.

## Upstream adaptation

OpenCode's service registration, health probe, identity/version validation, stale process checks and compare-before-release behavior were studied and adapted to TermAgent's workspace-bound owner model. The supplied OpenClaude source archive's `src/server/lockfile.ts` is an explicit no-op stub; it was inspected but not copied. Full notes are in `docs/research/PHASE14F-UPSTREAM-DAEMON-OWNER-ADAPTATION.md`.

## Verification

- `npm run build`: PASS.
- Focused Phase 14F tests: 11/11 PASS (10 daemon-owner unit/integration cases plus the server lifecycle/duplicate-owner integration case).
- Coverage includes exclusive acquisition, simultaneous contenders, different workspaces, dead-owner reclaim, Linux PID reuse detection, successor-safe release, POSIX modes, pending interaction reconciliation, interrupted turns, authenticated health metadata, duplicate server rejection, TUI/server owner conflict, shutdown release and clean re-acquisition.

The earlier known repository-wide `/auto` CLI assertion and full-suite timeout have not been reclassified or claimed fixed by this slice. Physical Android/Termux/Brave testing has not been performed in this environment.

## Remaining Phase 14F work

- Convert the existing TerminalUI/REPL into a typed daemon client for shared-session mode.
- Make terminal and browser attach to the same Agent runtime and canonical command/event protocol.
- Route terminal permission/question interactions and cancellation through daemon-owned commands.
- Test browser + terminal + second browser convergence, attach/detach, racing commands and active-run cancellation.
- SSE backpressure, durable tail polling, and transient-gap reconciliation are implemented and verified in Phase 14F.2.
- Test actual Android/Termux/Brave and network handoff behavior.

**Conclusion:** Phase 14F.1 establishes a tested owner boundary and safe restart reconciliation. Phase 14F is not complete.
