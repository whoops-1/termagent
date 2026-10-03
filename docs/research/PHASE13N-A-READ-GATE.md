# Phase 13N-A — Pre-execution semantic read gate

Status: implementation complete; rollout gate remains subject to the repository-wide verification contract.

Date: 2026-10-01

## Scope

13N-A closes the remaining `read_file` failure identified during the reopened Phase 13M verification. The existing `FileReadStateCache` already knew when requested lines were covered, but the relevant TermAgent subsystem treated a fully covered non-exact request with `status: "fresh"` as a real read and fell through to `readLinesWithRanges()`.

That made semantically redundant reads execute against the filesystem even though the session already held the evidence. The semantic loop guard could eventually stop the sequence, but only after the redundant tool execution had happened.
The implementation keeps the existing TermAgent cache and adapts the design pattern rather than introducing a second state system.

the design notes:
- repository: `the implementation`
- relevant area: the relevant TermAgent subsystem and the session processor/doom-loop handling
- current design read guidance continues to favor broad, purposeful reads and independent parallel reads rather than tiny repeated slices.

the design notes:
- repository: `the implementation`
- relevant areas: file-state handling, tool execution coordination, session persistence, and renderer/client state
- the adapted pattern is a bounded file-state cache that distinguishes already-known model evidence from data that must be rehydrated after compaction.

These references inform the behavior, but TermAgent continues to use its existing `FileReadStateCache`, `ExplorationState`, `ToolLoopGuard`, and `SessionStore` infrastructure.

## Implemented behavior

### Explicit cache classification

`ReadCacheStatus` now includes:

- `unchanged`: the exact non-truncated request is already visible to the model.
- `already-covered`: a non-exact requested range is fully covered and the evidence is still visible.
- `rehydrated`: the requested range is fully cached but the model lost that evidence during compaction, so cached content is reconstructed without another file read.
- `overlap`: only part of the requested range is new, so only uncovered ranges are read.
- `fresh` / `miss`: new source content must be inspected.

### Pre-execution gate

the relevant TermAgent subsystem now returns an `already-covered` result before `readLinesWithRanges()` is called. It also postpones the text/binary inspection sample until a real content read is required.

The version check still happens first through `fs.stat()`, so a file that changed since the cached evidence was recorded does not receive a stale cache hit.

### Context-visible coverage

`FileReadStateCache` now keeps a small ephemeral `contextCoverage` projection. It records complete ranges currently visible in the prompt and clears them on compaction.

This lets the cache distinguish:

1. evidence still visible, which should not be reproduced;
2. evidence still valid but no longer visible, which may be rehydrated from the bounded cache; and
3. evidence invalidated by file-version drift, which must be read again.

The ephemeral projection is not durable session truth.

### Truncation correctness

Only complete returned segments contribute to coverage. Output-level byte truncation no longer incorrectly marks every visible head/tail segment as incomplete; only genuinely line-truncated source text stays incomplete.

Durable context projections likewise exclude incomplete segments.

## Context-budget integration fix

The semantic gate exposed a nearby budgeting edge in the existing agent loop. Intervention text is appended to the provider request after `maybeCompact()` evaluates the base message set. A narrow remaining budget could therefore make the final request slightly exceed the limit even though the compaction pass had decided the base context fit.

The existing compaction path now accepts an estimated additional request-token reserve, and request construction re-checks the final message set after compaction. `truncateToTokenBudget()` also reserves its truncation marker tokens instead of appending the marker after the budget has already been consumed.

This change keeps one context-budget estimator and the existing compaction/checkpoint machinery.

## Verification

Focused verification after the implementation:

- `npm run build`: PASS
- 13N-A read-gate tests: 7/7 PASS
- Phase 13M-P4 intervention tests: 6/6 PASS
- Phase 13B read-state tests: 14/14 PASS
- Phase 13M hardening tests: 4/4 PASS
- Combined focused suite: 30/30 PASS

The deterministic Build-mode workload now reaches the semantic stop without reproducing the historical filesystem-read exhaustion behavior. Redundant ranges can still appear as model-requested tool calls because the model is the actor producing the call, but the `read_file` tool returns an `already-covered` cache result instead of performing another content read.

## Remaining verification limits

The repository-wide aggregate `npm test` runner remains a known non-clean gate because of pre-existing test failures and process-lifecycle timeout behavior documented in the existing Phase 13M revalidation report. Those failures have not been attributed to 13N-A.

The verification host is x86_64, so no physical ARMv7 Termux execution is claimed here.

## Completion interpretation

13N-A implementation tasks are complete. The broader Phase 13N gate remains open until its later sections are implemented and the repository-wide release verification contract is satisfied.
