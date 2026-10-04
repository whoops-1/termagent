# Phase 13N-J-A — Mobile Process Lifecycle Hardening

## Scope

This sub-phase hardens the existing `TaskManager` / managed-shell runtime for
Termux/Android-style POSIX process behavior. It does not replace the durable
task architecture or create a second process database.


Relevant implementation studied:
Design decisions carried into TermAgent:

- Detached POSIX children establish their own process group.
- Stop/cancellation targets the process group first rather than only the shell
  leader.
- A bounded escalation path moves from `SIGTERM` to `SIGKILL`.
- Process cleanup is treated as part of the command lifecycle rather than as
  an unrelated UI concern.

### the implementation


Relevant implementation studied:
- `install.sh`

Design decisions carried into TermAgent:

- Long-lived processes keep bounded output tails.
- Each process owns a Unix process group so descendants are stoppable.
- Stdin writes have an explicit one-second deadline.
- EOF is represented explicitly instead of leaving stdin ownership ambiguous.
- Pipe draining is bounded after termination so a descendant-held descriptor
  cannot keep cleanup open forever.

The TermAgent adaptation stays dependency-free and uses its existing durable
output file plus bounded preview model rather than adding a second in-memory
process store.

## Implemented changes

### Process groups

Added the relevant TermAgent subsystem with reusable POSIX lifecycle primitives:

- process-group existence probing
- group signalling
- bounded wait-for-group-exit
- `SIGTERM` → `SIGKILL` escalation
- timed child-stdin writes

### Descendant cleanup

Foreground managed shells now check for a surviving process group after the
shell leader exits. A lingering descendant group is terminated before the task
becomes visible as settled, and a durable `descendant_cleanup` event records
the cleanup result.

Explicitly backgrounded processes retain their existing lifetime semantics.
They are not swept away simply because the foreground shell layer returned.

### Cancellation

`TaskManager.cancel()` keeps the existing process-identity check before any
signal is sent. When an identity-verified process group is signalled, the
lifecycle helper supplies bounded forced termination if the group ignores the
initial request.

Backgrounded tasks whose leader has exited but whose managed process group is
still alive remain individually cancellable.

### Bounded previews

Shell previews now respect the requested UTF-8 byte budget including the
truncation marker. The preview keeps a head/tail split while avoiding accidental
over-budget output caused by the marker itself.

The existing durable output file remains available for explicit task output
retrieval, while task state only retains a bounded preview.

### Stdin deadlines

Managed shell input can now be supplied through the existing shell lifecycle
with a one-second default write deadline. A timed-out write is reported as an
indeterminate delivery condition and callers are instructed not to blindly
retry. The shell is terminated using the same process-group lifecycle.

A new `stdin-timeout` termination state is persisted alongside the existing
termination reasons.

## 13N-J-C addendum — shell background ownership and semantic loop scope

The 2026-10-03 Termux trace exposed two interactions at the service-start boundary. First, a successful `sh -lc '... & ...'` shell can finish while the intentionally backgrounded child remains alive. The managed runner therefore recognizes explicit shell background syntax and preserves that descendant after a successful shell-leader exit, matching the useful OpenCode process-group behavior observed in the pinned `cross-spawn-spawner.ts`: successful completion does not trigger group cleanup merely because descendants may still exist. Cleanup remains active for ordinary foreground completion, cancellation, timeout, output-limit, and stdin-timeout paths.

Second, the trace showed that exploration no-progress state could remain active after earlier repository reads and then classify distinct later bash rounds as stagnant. TermAgent now keeps semantic no-progress accounting on exploration/state rounds and prevents operational shell/write rounds from inheriting that streak. This does not relax exact repeated-call safety.

The shell result contract also carries `backgroundChildrenPreserved` and `addressInUse`. A detected `EADDRINUSE` is surfaced both as metadata and a model-facing instruction to inspect/reuse the endpoint before another launch.

Upstream references studied for this correction: OpenCode `packages/core/src/tool/bash.ts` and `packages/core/src/cross-spawn-spawner.ts` at revision `7945de208964a49300d7f770d1a71d078db9a4c4`, plus LaudaCode `src/processes.rs` and `src/tools.rs` at revision `f8906ce9da3b11c83fca4b296e0a90f5c7d39110`.

## Verification

- `npm run build` → **PASS**
- 13N-J-A process lifecycle suite → **8/8 PASS**
- 13E shell/process regressions → **13/13 PASS**
- 13I task regressions → **11/11 PASS**
- Combined process/task gate → **32/32 PASS**

Focused 13N-J-C regression coverage now includes the real bash/server lifecycle: an intentionally backgrounded service survives the shell boundary, a later health check can reuse it, and a duplicate launch returns structured `EADDRINUSE` guidance.

The aggregate repository `npm test` command remains a separate known gate
because the existing provider-manager test process can fail to terminate.

Physical Termux/ARMv7 execution is intentionally not marked complete on the
x86_64 verification host. That remains the final 13N-J rollout gate.

## Next sub-phase

13N-J-B covers release engineering: target detection, Android/ARMv7 release
bundles, checksum manifests, prebuilt-first installation, source-build
fallback, and Termux-specific installer verification.
