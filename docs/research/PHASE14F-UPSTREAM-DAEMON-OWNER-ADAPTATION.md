# Phase 14F — Upstream daemon ownership and service discovery research

**Research date:** 2026-11-01  
**Implementation slice:** Phase 14F.1 — exclusive workspace owner and restart reconciliation

## Executive decision

Use OpenCode's service-registration and probe/ensure lifecycle as the primary reference, adapted to TermAgent's single-owner topology and existing Node.js filesystem/session primitives. Do not copy an upstream implementation wholesale.

The supplied OpenClaude archive was inspected as requested. Its `src/server/lockfile.ts` explicitly describes itself as an inert stub: `writeServerLock()` and `removeServerLock()` are no-ops, and `probeRunningServer()` always returns `null`. It is useful evidence that the current checked-in package does not implement an owner lock, not an implementation to port. OpenClaude's `docs/grpc-server.md` describes its intended streaming server surface, but the supplied source snapshot's server and session manager are stubs. TermAgent therefore does not claim parity from that archive.

## OpenCode implementation studied

The following OpenCode files were inspected at commit `288fa1284309d05013e3f85979e5ac2b598fd35e`:

- [`packages/client/src/service.ts`](https://github.com/anomalyco/opencode/blob/288fa1284309d05013e3f85979e5ac2b598fd35e/packages/client/src/service.ts) defines the client contract for endpoint discovery, service identity, process ID, version, and optional authentication.
- [`packages/client/src/service-probe.ts`](https://github.com/anomalyco/opencode/blob/288fa1284309d05013e3f85979e5ac2b598fd35e/packages/client/src/service-probe.ts) reads a registration record, probes `/api/info`, checks the reported process ID and version, and classifies the service as ready, waiting, or failed. A missing health route is treated as protocol incompatibility rather than blindly killing the process.
- [`packages/client/src/promise/service.ts`](https://github.com/anomalyco/opencode/blob/288fa1284309d05013e3f85979e5ac2b598fd35e/packages/client/src/promise/service.ts) implements discover/ensure/stop, bounded probing, competing startup contenders, process termination, and owner-record comparison before cleanup.
- [`packages/client/src/effect/service.ts`](https://github.com/anomalyco/opencode/blob/288fa1284309d05013e3f85979e5ac2b598fd35e/packages/client/src/effect/service.ts) documents a private registration file as the service discovery contract and exposes a health-checked incumbent lookup.
- [`packages/client/test/service.test.ts`](https://github.com/anomalyco/opencode/blob/288fa1284309d05013e3f85979e5ac2b598fd35e/packages/client/test/service.test.ts) covers concurrent startup, reuse, stale/crashed owners, hung service replacement, PID identity, and avoiding deletion of a successor's registration.

Related OpenCode authorization source was also reviewed earlier in Phase 14E: `packages/server/src/middleware/authorization.ts` centralizes access checks, and `packages/server/src/auth.ts` owns session credential validation. Phase 14F does not modify that security layer.

## Adaptation to TermAgent

TermAgent has a different requirement from a generic background HTTP service: the sole owner includes the Agent, active turn controllers, PermissionGate waiters, SessionStore writer, TaskManager, providers, and the in-process event bus. Therefore the registration is bound to a canonical workspace path, not merely a port.

`src/server/daemon-owner.ts` implements:

- A workspace key derived from SHA-256 of the canonical path.
- A private state directory under `~/.termagent/daemons` (or an injected test directory), created with POSIX mode `0700`.
- Exclusive owner creation through `open(..., 'wx')`, with owner metadata and lock files mode `0600`.
- Owner identity containing a random instance ID, random lease token, PID, process-start identity where `/proc` is available, mode (`server` or `terminal`), and start time.
- A separately atomically replaced metadata record containing lifecycle state, heartbeat time, and the optional Web View endpoint. The private lease token is never included in `/health`.
- A short-lived recovery guard. Reclaimers re-read the same owner token under the guard before removing an owner record.
- Fail-closed behavior when a process may still be alive but its identity cannot be verified. On Linux/Android, `/proc/<pid>/stat` start time helps distinguish PID reuse from the original process.
- Compare-before-release so an old process cannot delete a successor's owner record.

The server runtime acquires the lease before runtime composition, publishes the ready endpoint in owner metadata, and exposes safe owner identity/heartbeat data through the existing authenticated `/health` response. The standalone terminal entry acquires the same workspace lease. During this interim slice it fails clearly when a server already owns the workspace; it does not silently instantiate a competing Agent runtime.

Once exclusive ownership is established, `SessionStore.recoverOrphanedRuntimeState()` scans only sessions for the canonical workspace. It durably cancels orphaned permission waits with reason `daemon-restart`, cancels unanswered questions with a daemon-recovery client identity, and writes an explicit `interrupted` status for unmatched `started` turns. It never synthesizes a successful completion and never restores workspace files automatically.

## Deliberate non-adaptations

- No copying of OpenCode's service password or Basic-auth contract. TermAgent's Phase 14E device pairing and bearer scopes remain authoritative.
- No multi-contender process pool: TermAgent's accepted Option A is one owner. A second launch receives a clear owner error until it is converted into a client in a later 14F slice.
- No cross-process event broker, Redis, database, or WebSocket. The daemon's `SessionEventBus` remains a same-process wakeup; JSONL sequence replay remains durable truth.
- No automatic restart or kill of an apparently live but unhealthy owner in this slice. That needs a verified health protocol and active-run/task recovery policy.
- No POSIX `flock` dependency, native addon, or shell-based PID probing. Exclusive file creation and process identity use Node APIs to preserve Termux compatibility.

## Remaining work

Phase 14F.1 is the ownership foundation only. The interactive terminal is not yet a daemon client, so terminal and browser cannot yet operate simultaneously against the same live runtime. Phase 14F.2 must adapt the existing TUI to `src/client/client.ts` and the canonical HTTP command/SSE protocol, or add a local IPC adapter that reuses the exact same command/event schemas. Later slices still need SSE backpressure/gap handling, two-browser-plus-terminal convergence tests, client attach/detach, and physical Android/Brave validation.
