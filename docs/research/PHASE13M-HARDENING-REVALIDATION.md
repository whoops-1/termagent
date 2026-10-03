## 2026-09-30 — Production regression revalidation

The historical 13M completion claim is reopened by a real Build-mode session trace. The earlier Explore-mode trace remains evidence that coverage-aware reading can progress correctly; the two modes must not be treated as one identical failure.

### Behavioral evidence

- Build-mode session: 182 events, 56 tool-call records, repeated `crypto.py` reads, repeated context compactions, and no visible semantic nudge/constrain/stop before the legacy exact-repeat backstop blocked an identical call.
- Explore-mode session: 61 events and monotonic `crypto.py` coverage progression through previously missing ranges. An overlapping request was useful when it contained uncovered lines.

### Root cause identified in TermAgent

1. the relevant TermAgent subsystem included tool lifecycle records in the semantic fingerprint. New call/turn/output-reference/timestamp values could therefore look like semantic progress even when exploration state did not change.
2. the relevant TermAgent subsystem could feed failed/blocked tool settlements into exploration observation. A refusal is execution control flow, not new repository evidence.
3. the relevant TermAgent subsystem treated a partially populated version record as a replacement for complete version evidence, allowing missing fields to disturb previously known coverage.

### Current hardening

- Semantic fingerprints now derive semantic exploration progress from durable domain state rather than lifecycle bookkeeping.
- Failed or constrained tools no longer mutate `ExplorationState`.
- Version changes are detected only from version fields actually present in the new observation, so incomplete metadata cannot erase valid coverage.
- Existing nudge → constrain → stop behavior remains authoritative, with semantic action constraints checked before tool execution.
- A deterministic Build-mode fixture based on the historical `crypto.py` read sequence verifies termination before the historical 19-read sequence is exhausted.
- A forced-compaction regression verifies coverage survives checkpoint persistence and is authoritative after a fresh `Agent` instance is restored.

### Verification evidence

- Production TypeScript build: PASS.
- Targeted Agent/P4/P6 regressions: 29/29 PASS.
- New 13M hardening regressions: 4/4 PASS.
- Repository-wide independent test-file run: 65 PASS, 9 FAIL across 74 test files. All 9 failures reproduce against the untouched `TermAgent-1.18.0-Phase14A.zip` baseline and are outside the changed exploration paths.
- Aggregate `npm test`: still subject to the repository's known non-termination behavior; this is not counted as a passing aggregate gate.
- ARMv7/Termux hardware execution: unavailable on the current x86_64 verification host.

### Gate disposition

The exploration machinery is hardened against the observed Build-mode failure, but Phase 13M is intentionally **REOPENED** until the current behavior is re-run in the real Termux/ARMv7 environment and the remaining repository baseline failures are separately disposed of. Phase 14 Web View work stays behind this gate.

## Implementation scope

This revalidation intentionally keeps the existing TermAgent architecture. It does not replace the agent loop, read-state cache, checkpoint format, or loop guard. The changes are limited to correcting the semantic-evidence boundaries exposed by the production trace.
The Phase 13 hardening review confirmed two boundaries: the loop guard remains an exact-identical-input backstop, and Explore remains a read-only role built on the existing search/read tools. Runtime semantic state remains authoritative, with client rendering layered above it.

## Changed files

- the relevant TermAgent subsystem — remove lifecycle bookkeeping from the semantic fingerprint.
- the relevant TermAgent subsystem — keep failed/constrained tool calls out of exploration evidence and publish runtime telemetry/termination consistently.
- the relevant TermAgent subsystem — tolerate partial version evidence without invalidating existing coverage.
- `tests/agent.test.mjs` — align loop-guard regression expectations with nudge → constrain → stop and isolate the generic read-only fallback test.
- `tests/agent/phase13m-hardening.test.mjs` — add the production-regression, lifecycle-churn, version-evidence, and compaction/restore coverage.
- `tests/fixtures/phase13m-build-mode-read-sequence.json` — deterministic reproduction extracted from the Build-mode session.

