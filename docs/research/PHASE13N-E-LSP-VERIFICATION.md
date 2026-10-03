# Phase 13N-E — LSP Verification Correctness

Date: 2026-10-02

## Scope

This phase hardens the truth model around asynchronous Language Server Protocol diagnostics. It does **not** introduce a second language-server process manager. The implementation provides a reusable diagnostic state machine and connects its state to the existing semantic evidence/verification architecture. Full LSP process/session management remains a later capability item.
The design was checked against the existing the language-server integration diagnostic registry/notification path and the language-server integration implementation checked for this project. The common lesson is that `publishDiagnostics` is an asynchronous stream, not a boolean test result. the implementation already coalesces repeated diagnostic publications and bounds diagnostic delivery. the the documentation describes the sharper correctness rule: an initial empty publication can arrive before analysis is complete, so an empty set must not be treated as clean until an explicit settle policy is satisfied or the diagnostic budget expires.

The diagnostic model distinguishes push updates, pull-style requests, and bounded waits. This phase keeps that correctness boundary while leaving full language-server lifecycle management to a separate capability.

## Implementation

the relevant TermAgent subsystem provides `LspDiagnosticTracker`.

A run has the following states:

- `unknown`: no run exists for the requested key.
- `running`: a run exists but no diagnostic publication has arrived yet.
- `provisional`: diagnostic evidence exists but the result has not met the settlement policy.
- `clean`: the diagnostic stream settled with no error-severity diagnostics. Warning/info/hint-only results may settle as clean.
- `failed`: the settled diagnostic set contains one or more error-severity diagnostics, or the producer reports an explicit failure.
- `timed_out`: the diagnostics budget expired before a valid settlement.
- `cancelled`: the run was explicitly cancelled or its abort signal fired.

Every publication replaces the bounded current diagnostic set for the file and refreshes the quiet period. The tracker deduplicates identical diagnostics within the bounded set so repeated notifications do not create unbounded state.

Empty publications receive an additional minimum-settle guard. Therefore this sequence is intentionally represented as:

```text
publish []       -> provisional
publish [error]  -> provisional
quiet + settle   -> failed
```

An early empty publication that never settles before the budget expires becomes `timed_out`, not `clean`.

## Semantic evidence

`EvidenceLedger` now stores bounded LSP state per server/file with:

- status
- diagnostic count
- error count
- warning count
- bounded reason text

Lifecycle records carrying `metadata.lspDiagnostics` are normalized automatically. Task IDs, output paths, publication timestamps, and publication counts are not included in the semantic fingerprint.

`ExplorationState` treats only terminal LSP states (`clean`, `failed`, `timed_out`, `cancelled`) as settled semantic verification facts. `running` and `provisional` are explicitly excluded from exploration progress so uncertainty cannot manufacture progress.

## Verification

Dedicated tests: **12/12 PASS**.

The suite covers:

1. minimum settle handling for empty first publications
2. asynchronous stale-to-final publication sequences
3. error diagnostics settling as failed
4. diagnostics budget expiry
5. explicit cancellation
6. duplicate-publication coalescing
7. semantic fingerprint stability against lifecycle timing/count changes
8. provisional versus settled exploration evidence
9. bounded ledger representation without task/output identity
10. automatic lifecycle-to-ledger normalization
11. explicit unknown state
12. empty publication timing out when the budget is shorter than the minimum settle window

`npm run build`: PASS.

The broader focused 13M/13N suite is green except for the pre-existing Phase 13D/13N-D 13B tiny-budget compaction test; running that exact test against the untouched 13N-D archive reproduces the same failure, so it is not attributed to 13N-E.

The aggregate repository test runner remains a separate known gate because of long-lived test/process behavior. Physical ARMv7/Termux execution was not available on the x86_64 verification host.

## Non-goals

This phase intentionally does not claim:

- LSP server discovery or process startup
- `initialize` / `initialized` lifecycle management
- `didOpen` / `didChange` document synchronization
- LSP position encoding conversion
- pull diagnostic request implementations
- definition/references/hover/symbol operations
- live terminal UI rendering of LSP diagnostics

Those belong to the later dedicated LSP/code-intelligence capability phase and can consume this diagnostic correctness contract without replacing it.
