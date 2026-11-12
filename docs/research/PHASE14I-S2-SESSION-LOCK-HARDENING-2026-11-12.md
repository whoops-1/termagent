# Phase 14I-S2 — Session-state lock hardening design decision

**Status:** Implemented by work stream 14I-S2 (batch 1)
**Date:** 2026-11-12
**Scope:** `src/session/store.ts` state lease only; `tests/session/session-lock.test.mjs` added. The durable-sequence append optimization (TODO 14I write-amplification item) is deliberately deferred to batch 2; the JSONL append contract is unchanged.
**Note:** `src/tasks/manager.ts::acquireNamedLock` (owned by 14I-S1) carries the same fixed 60×10 ms loop and pid-only ownership pattern; the identical hardening should be applied there or via a shared primitive in a later batch.

## Decision

`SessionStore.acquireStateLease` was a fixed 60-iteration × 10 ms retry loop (~600 ms budget) that threw `Session state is busy: unable to acquire state lock` with no diagnostics, and classified lock payloads by pid liveness only. It is replaced by a classification-driven bounded acquisition:

```text
EEXIST → read payload
  ├─ read ENOENT            → gone: retry open immediately (owner released mid-classification)
  ├─ payload unparseable    → malformed: fresh mtime (< 5000 ms) → wait; aged → recover (rm)
  ├─ payload incomplete     → malformed: same freshness rule (pid/token/started must be valid)
  │                            (pid integer > 0 AND finite started > 0 AND non-empty token)
  ├─ kill(pid,0) succeeds   → live owner: wait. NEVER delete.
  ├─ kill(pid,0) → ESRCH    → stale owner: recover (rm) immediately
  └─ kill(pid,0) other error → treat as live (EPERM/EACCES = could not prove death)
```

Waiting uses bounded exponential backoff with jitter: 10 ms initial, doubling to a 200 ms per-wait cap, each wait jittered to 50–100 % of the doubling value and clamped to the remaining budget. Total budget is `TERMAGENT_SESSION_LOCK_TIMEOUT_MS` (default **5000 ms**, parsed with a local safe-integer helper mirroring `envNonNegativeInt` in `src/config/config.ts` — the session domain must not import config). A value of `0` disables waiting (single attempt, immediate precise timeout) but does not disable stale/malformed recovery. An attempt bound of 512 protects against pathological recreate/delete churn; a small 1–10 ms jitter after each recovery prevents lockstep recovery loops.

Error text keeps the `Session state is busy:` prefix for downstream matching and is enriched with the decisive classification, e.g. `...after 6 attempt(s) and 197 ms wait (live owner pid 15516 still holds the state lock)` or `(malformed or incomplete state lock contents)` / `(acquisition attempts exhausted)`. A live owner's lock is never deleted on timeout; a fresh malformed lock is never deleted by a short timeout; a dead owner's lock is recovered immediately regardless of remaining budget.

Release is compare-before-delete: `releaseStateLease` deletes only when the on-disk payload token equals the acquired token (the token is the capability; the previous extra `pid === process.pid` condition was dropped so any legitimate token holder can clean up, while a foreign/tampered owner's lock can never be removed).

Diagnostics: one bounded in-memory record per store, `lastSessionLeaseContention(): { sessionId, operation, attempts, waitedMs, outcome: 'acquired'|'recovered-stale'|'recovered-malformed'|'timeout', ownerPid?, decidedAt } | undefined`, populated only when at least one `EEXIST` was observed (clean acquisitions do not overwrite it). `operation` is `'mutation'` (via `withSessionMutation`) or `'append'` (via `appendUnlocked`). This is LIVE state, not durable: no new event kinds, no persistence, no message/credential content.

## Explicit limitation (deferred to the Windows-port stream)

Cross-platform process-start identity (pid + process start time) is not implemented here. Stale detection relies on pid liveness plus the lock file's mtime/`started` heuristics; a recycled pid can keep a stale lock looking live until its contents age past the malformed-fresh threshold. The comment above `acquireStateLease` records this in code.

## Verification

- `npx tsc -p tsconfig.json --noEmit --pretty false` → PASS (0 errors repo-wide at integration time).
- `node --check tests/session/session-lock.test.mjs` → PASS.
- Isolated temp-emit smoke run (`tsc -p tsconfig.json --outDir <temp>`, scratch script importing the temp emit) exercised all eight classification paths against the real emitted code: uncontended acquire/release, contended wait-then-acquire (waitedMs 128), stale recovery (immediate, `recovered-stale` + dead pid), fresh-malformed timeout with intact lock, aged-malformed recovery, live-owner budget timeout with intact lock and precise pid error, zero-budget immediate timeout (attempts 1, waitedMs 0), compare-before-release (foreign token preserved, matching token releases).
- `tests/session/session-lock.test.mjs` encodes the same eight scenarios as the permanent regression suite (env-isolated fixture: `mkdtemp` + saveEnv/restoreEnv, `TERMAGENT_SESSION_ROOT` at a temp dir, short `TERMAGENT_SESSION_LOCK_TIMEOUT_MS` values). It executes at integration when `dist/` is built.
