# Phase 14F.3 — Terminal daemon client convergence

**Status:** implemented first convergence slice; Phase 14F remains open.  
**Baseline:** TermAgent 1.18.0, Phase 14F.2 source checkpoint.  
**Architecture:** Option A, one long-lived runtime daemon per canonical workspace.

## Objective

Make the interactive terminal attach to the existing server-owned runtime instead of constructing a second Agent, PermissionGate, SessionStore, provider set, task manager, or execution controller for a workspace already owned by a server. The browser and terminal must issue commands to the same runtime and observe the same durable session history.

## Implementation

### Terminal attachment and identity validation

- `src/cli/repl.ts` checks for a ready server owner before constructing standalone runtime state.
- It waits briefly for an owner in `starting` state, and rechecks after a competing owner acquisition failure to close the simultaneous-start race.
- When a server owner is present, the terminal enters `startDaemonClient()` and does not create a local Agent runtime.
- `src/cli/daemon-client.ts` confirms the registered owner ID/PID/mode/state using both `/api/info` and `/health`, and verifies that the server's canonical workspace path matches the terminal's working directory.
- Automatic daemon attachment accepts loopback HTTP(S) only. Non-loopback endpoints are rejected rather than silently treating a public endpoint as a local daemon. Explicit remote terminal attachment remains deferred.
- When no server owns the workspace, the existing standalone terminal path remains available and continues to acquire the exclusive workspace owner lease.

### Device pairing for terminal clients

- First-time terminal authentication uses the existing one-time pairing endpoint and accepts the ten-hex-character code from `TERMAGENT_PAIRING_CODE` or an interactive prompt.
- The server issues a device-scoped token. The terminal stores it in `~/.termagent/devices/<workspaceId>.json`, bound to the workspace and device ID.
- Credential writes use a temporary file, fsync, atomic rename, and POSIX owner-only directory/file modes (0700/0600).
- Subsequent terminal launches reuse the saved credential rather than pairing again.
- `/device revoke` revokes the current terminal device at the server and removes its local credential. The browser credential remains memory-only.
- Existing `TERMAGENT_SERVER_TOKEN` support is retained for deployments using a static local token.

### Shared command and runtime ownership

- Prompts are submitted through `TermAgentClient.enqueue()` and the daemon-owned durable queue. The terminal does not call `Agent.run()` locally when attached.
- The server daemon owns queue claiming/execution, provider calls, tool execution, permission waiters and question waiters.
- Queue items retain mode, custom-agent and autonomous metadata. Per-session queue workers execute one item at a time and recover queued items after daemon startup.
- The terminal routes interrupt/abort, queue mutations, undo/redo, compact, fork, session creation/switching, permission resolution and question resolution through the same server API/command ledger.
- Question and permission prompts discovered from the durable projection use the existing TerminalUI modals. Resolutions are committed by the daemon and retain first-writer-wins behavior.
- The terminal receives durable session events and transient live stream events through the existing HTTP/SSE protocol. Durable event sequence remains the recovery cursor; live deltas remain provisional.
- On an SSE gap, the terminal fetches the authoritative session snapshot and reconciles pending interactions/queue/Todo state.
- When the final durable assistant message differs from the streamed prefix, the terminal replaces the provisional assistant entry with the durable response. This recovers text lost during transient event interruption.

### Store concurrency correction discovered during integration

The terminal/daemon queue path exposed a pre-existing `SessionStore` reentrancy problem. A per-session process-wide mutation depth allowed unrelated concurrent async work to be mistaken for nested work, which could bypass the file lease and produce duplicate event sequence numbers.

The store now uses `AsyncLocalStorage` to associate nested mutation ownership with the actual async call chain. An unrelated worker no longer inherits another request's nested-mutation privilege. The `session.queue` API also schedules `kickQueue()` only after its `CommandLedger` transaction has completed, so the worker cannot race the command receipt append under the same mutation context.

This is not a distributed lock or a second event broker. The exclusive daemon owner remains the only runtime writer; the store lease protects individual durable mutations and the async context only detects legitimate nesting.

## Upstream study and adaptation

The implementation was informed by these OpenCode source paths:

- `packages/client/src/service.ts` — service registration and client discovery contract.
- `packages/client/src/service-probe.ts` — registered endpoint health, PID/version validation, and compatible-service decision.
- `packages/client/src/promise/service.ts` and `packages/client/src/effect/service.ts` — discover/ensure/stop lifecycle, re-use of a healthy daemon, bounded start/recovery, and compare-before-terminate behavior.
- `packages/cli/src/services/server-connection.ts` — CLI connection selection and separation of managed-server, explicit-server, and standalone modes.
- `packages/cli/src/services/service-config.ts` — channel-specific service registration/configuration and private local credential handling.
- `.opencode/skills/opencode-dev/SKILL.md` — explicit statement of the server-authoritative/TUI-client architecture and registration/health verification.

TermAgent keeps its own `DaemonOwner` lease, workspace-bound device scopes, `TermAgentClient`, command ledger, durable JSONL event log, and existing HTTP/SSE protocol. It does not copy OpenCode's service registration or Effect runtime wholesale. The existing OpenClaude source's `src/server/lockfile.ts` was previously inspected and is only an inert no-op stub, so it was not used as an implementation foundation.

Detailed adaptation notes: `docs/research/PHASE14F3-UPSTREAM-TERMINAL-DAEMON-CLIENT-ADAPTATION.md`.

## Supported terminal commands in daemon-client mode

`/help`, `/status`, `/sessions`, `/resume`, `/new`, `/plan`, `/build`, `/explore`, `/mode`, `/agent`, `/auto`, `/queue` (list/cancel/up/down/edit), `/interrupt`, `/cancel`, `/abort`, `/compact`, `/undo`, `/redo`, `/fork`, `/permissions`, `/questions`, `/device revoke`, `/quit`.

This is an initial shared-runtime command surface, not complete parity with the standalone REPL. Advanced provider/model selection, variants, plugin and marketplace management, theme/effect configuration, skills administration, external editor, checkpoint management, detailed task tools and the complete standalone command catalog are not yet exposed through daemon-client mode.

## Verification

- `npm run build` — PASS.
- `node --test --test-concurrency=1 tests/phase14*.test.mjs` — **63/63 PASS** (all Phase 14A–14F focused tests in the checkpoint).
- Dedicated Phase 14F.3 + owner integration tests — **7/7 PASS**.
- `node scripts/verify-dist.mjs` — PASS.
- `node dist/index.js --version` — reports `1.18.0`.
- `node --check web/app/app.js` — PASS.
- `npm pack --dry-run` — PASS, 317 packaged files.

The repository-wide `npm test` was attempted and did **not** complete green. It failed the existing `/auto` CLI integration assertion (`Expected: after\n`, actual `before\n`). The aggregate run also showed a transient Phase 13G interruption assertion failure; rerunning `tests/phase13g-tool-lifecycle.test.mjs` alone passed 15/15. The `/auto` assertion also fails when run alone. The aggregate run reached test 203 before the 600-second command timeout. No full-suite pass is claimed.

## Remaining Phase 14F work

- Full terminal/Web View parity for every visible state (tool lifecycle/details, task activity, diffs/checkpoints, metadata and all command surfaces).
- Real interactive TTY tests for terminal permission/question flows, simultaneous terminal + browser interaction, two browsers plus terminal, session switching and cancellation races.
- Detach/reconnect and daemon crash/restart behavior under live clients, including active-run semantics and interrupted-stream reconstruction.
- Explicit remote terminal attachment through secure device credentials; automatic attachment remains loopback-only.
- Physical Android/Termux/Brave/Chrome validation, including keyboard, resize, orientation, lifecycle and network handoff.
- Repository-wide regression gate must be green.

Phase 14F.3 is therefore a verified implementation slice, not Phase 14F closure.
