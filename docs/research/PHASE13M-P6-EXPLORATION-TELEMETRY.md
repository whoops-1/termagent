# Phase 13M-P6 — Exploration Efficiency Telemetry

Status: **implementation complete; preflight rollout gate remains separate**.

## Goal

Measure exploration efficiency from semantic outcomes rather than optimizing the agent toward a fixed number of calls. The telemetry is runtime-derived diagnostics for regression fixtures and future adaptive routing; it is not session truth.
Phase 13 already has a repeated-tool backstop and provider metadata plumbing, but exploration efficiency needs its own cumulative counters. This phase adds those counters as a reusable semantic telemetry model rather than deriving efficiency from transport activity.

The adaptation therefore reuses TermAgent's existing P2 `ExplorationState` and P3/P4 semantic loop mechanisms rather than inventing a parallel tracing architecture.

## Implemented model

the relevant TermAgent subsystem owns the runtime-only counters:

- `toolCalls` — provider-requested tool actions that reached settlement, including blocked/rejected actions.
- `usefulCalls` — calls that produced new semantic exploration evidence or a concrete semantic mutation/task/Todo signal.
- `repeatedCalls` — semantically repeated exploration actions using the same P4 exploration-action identity, so cosmetic probe/output arguments cannot manufacture uniqueness.
- `overlappingCalls` — read actions whose requested range overlaps previously covered lines.
- `newFiles` — cumulative unique files discovered by exploration evidence.
- `newRanges` — count of newly added covered range segments.
- `searchNovelty` — search observations that introduce a new semantic search observation.
- `rounds` — tool-bearing provider rounds only.
- `noProgressRounds` — tool-bearing rounds with no semantic progress.
- `terminationReason` — categorized runtime termination outcome.

Telemetry is emitted through the optional internal `Agent.run()` callback `onExplorationTelemetry`. The callback receives snapshots after each provider round and once at final cleanup. No telemetry event is appended to `SessionStore`; it remains derived diagnostics.

## Important correctness details

Telemetry is recorded at tool settlement, not at the first admission point. This makes every attempted provider tool action count exactly once even when P4 constrains a call before execution. Final assistant-only rounds are not counted as exploration rounds, so a semantic-stop final response does not appear as an additional no-progress exploration action.

The read observation contract now exposes `overlap`, which is calculated from the requested range and prior semantic coverage rather than inferred from output text.

Repeated-call telemetry reuses the canonical P4 exploration-action identity. For `read_file`, identity includes path and meaningful line range but excludes cosmetic probes; Grep/Glob/repo-map likewise use their semantic fields.

Termination reasons remain separate from the human-readable loop-guard message. A semantic P4 stop reports `semantic-no-progress`; a generic raw repeat/read-only/write guard reports `loop-guard`; natural completion reports `completed`; explicit step exhaustion reports `tool-budget`.

## 33-call crypto.py reproduction

`tests/fixtures/phase13m-p6-crypto-33-call.json` contains a deterministic 33-potential-call workload for a 1,372-line `crypto.py` file:

1. five useful 200-line reads covering lines 1–1000;
2. twenty-eight syntactically varied rereads of the already covered 201–400 range.

The fixture is intentionally shaped around the documented repeated-read failure pattern. It is a deterministic reproduction workload, not a claim that an unrecorded historical transcript has been reconstructed byte-for-byte.

With the P2/P3/P4 runtime, the agent stops after the useful evidence plus the bounded semantic intervention ladder instead of exhausting the historical 33-call workload. The test records the resulting telemetry, including useful calls, semantically repeated actions, overlap, new ranges, and the semantic termination reason.

## Long legitimate exploration regression

A second fixture makes forty distinct 10-line reads in Explore mode. It verifies that the telemetry does not turn the historical 33-call observation into a new fixed ceiling. The run completes with forty useful calls and forty new ranges, with zero no-progress rounds.

## Decision

Measure **semantic progress**, not raw call count. The telemetry exists to explain why exploration ended and to provide evidence for future adaptive routing. It must never become another hidden fixed-call limiter.
