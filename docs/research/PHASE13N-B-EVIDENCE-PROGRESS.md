# Phase 13N-B — Evidence-Based Exploration Progress

Date: 2026-10-01

Status: **VERIFIED at focused implementation/regression level**

## Scope

13N-B hardens the existing exploration state and loop-guard path so that exploration progress is derived from genuinely new repository evidence rather than call bookkeeping, cosmetic input changes, output references, or context reconstruction.

This phase does not replace `SessionStore`, `ToolLoopGuard`, `FileReadStateCache`, or `ExplorationState`. It extends the existing evidence path already introduced during 13M preflight.
The implementation extends the existing evidence model with semantic progress accounting.

- the design notes revision: `the implementation`
- the design notes revision: `the implementation`
- the recorded behavior: `the implementation behavior`

The key adaptation is evidence-oriented exploration accounting while preserving the existing TermAgent runtime/session architecture.

## Implementation

### 1. Explicit evidence deltas

the relevant TermAgent subsystem now exposes `ExplorationEvidenceDelta` for every exploration-capable observation. The delta contains:

- newly discovered files
- newly covered read ranges
- ranges reconstructed from durable cache evidence
- novel search-result count
- newly discovered symbols
- newly settled verification facts

The existing top-level observation fields remain for compatibility with the P4/P6 consumers.

### 2. Read evidence is semantic, not syntactic

For `read_file`, only returned/complete source ranges can extend coverage. A fully covered range therefore produces no new range evidence. A rehydrated range is recorded as reconstructed context evidence, but it does **not** increment semantic progress or mutate the durable coverage fingerprint.

This keeps post-compaction context recovery useful without allowing the same repository facts to reset no-progress detection.

### 3. Search evidence is deduplicated

`grep`, `glob`, and `repo_map` evidence is deduplicated across observed results. Newly seen files, symbols, and result keys count as progress only once. A new pagination/signature variant with no new evidence remains semantically non-progressing.

Search result-key paths are normalized relative to the active exploration `cwd`, preventing process-global working-directory differences from altering evidence identity.

### 4. Verification becomes semantic evidence

Settled verification metadata can now produce a stable evidence fact even when the current verification tool only exposes `{ status, command, exitCode, signal }`. The command itself is hashed before being incorporated into the evidence fact so progress state does not retain potentially sensitive command text.

Explicit verification facts remain preferred when a tool already supplies them.

### 5. Lifecycle and cosmetic churn remain excluded

The semantic fingerprint continues to ignore call IDs, turn IDs, timestamps, output references, task IDs, retry counters, and renderer-only state. The P4 nudge → constrain → stop policy remains unchanged, and the exact-identical-call doom-loop guard remains a separate emergency backstop.

## Test coverage

`tests/agent/phase13n-b-evidence-progress.test.mjs` covers:

1. new read coverage versus redundant covered ranges
2. rehydrated evidence without semantic-fingerprint change
3. novel search results versus repeated search results
4. deduplicated settled verification facts
5. automatic semantic verification facts with command-sensitive data excluded from persistence
6. telemetry evidence counters and cosmetic/canonical call identity

The Phase 13M-P6 telemetry expectations were updated to include the newly exposed evidence dimensions while retaining the existing counters.

## Verification

- `npm run build` — PASS.
- 13N-B evidence-progress suite — **6/6 PASS**.
- Combined Phase 13M hardening/P4/P6 + 13N-A/B focused regression set — **26/26 PASS**.
- Aggregate `npm test` remains a separate repository-level gate issue and was not reclassified as passing by this phase.
- Physical ARMv7/Termux execution remains unavailable on the current x86_64 verification host.

## Gate conclusion

13N-B is verified at the focused source/test level. This does not close the broader Phase 13M rollout gate. The next planned work remains 13N-C, production exploration-guidance wiring, with the Web View phase still held behind the reopened exploration gate.
