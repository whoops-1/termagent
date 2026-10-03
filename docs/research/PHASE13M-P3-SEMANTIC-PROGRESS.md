# Phase 13M-P3 — Semantic no-progress detection

## Status

Complete. The implementation replaces the previous output/reference-oriented no-progress identity with a cumulative semantic projection built from TermAgent’s existing exploration and runtime state.

The exact-repeat guard remains a narrow emergency backstop. P3 adds a broader semantic progress projection based on `ExplorationState`, mutation/task/workflow state, and the existing `ToolLoopGuard`, so repeated transport activity cannot masquerade as repository progress.

## Implementation

### the relevant TermAgent subsystem

`buildSemanticProgressSnapshot()` produces a renderer-independent semantic state containing:

- discovered files, file versions, read coverage, full-coverage status, searches, and symbols;
- Todo task/status/priority state without Todo IDs;
- mutation path/operation and before/after content hashes with diff counts;
- task lifecycle state, outcome, status, command/prompt/scope, timeout/termination/exit state, without generated task IDs or process/transport IDs;
- autonomous workflow phase, iteration, plan/completion counts, dirty state, verification status, and verification failure count.

The resulting snapshot is canonicalized and SHA-256 hashed.

### Ephemeral data exclusion

The fingerprint excludes data that can change while the observed repository/task state is unchanged, including:

- `tool-output://` references;
- managed output paths;
- call IDs and turn IDs;
- generated Todo/task identifiers;
- child session IDs;
- timestamps and process-style lifecycle metadata;
- workflow repeat/no-progress counters that would otherwise let the detector manufacture its own progress.

Task error text is also not part of the semantic fingerprint. Stable task outcome/state fields are sufficient for loop detection without importing arbitrary generated paths or transport text into the progress identity.

### Read coverage across turn boundaries

P2 exploration state is checkpointed, while `FileReadStateCache` is intentionally per-Agent-run. A new run can therefore have an empty cache while the restored exploration projection already records lines previously inspected. `ExplorationState.observeRead()` now computes semantic novelty against its own same-version coverage instead of trusting a fresh cache's `newlyCovered` bookkeeping. Returned line ranges are used where available.

This makes a repeated read after restart/compaction remain no-progress when the file version is unchanged, while an actually uncovered range remains progress. A changed file version invalidates the prior coverage and is treated as fresh evidence.

### Search semantics

The exploration observation layer still keeps a raw search signature for observation/cache identity. P3 does not fingerprint that raw signature. The semantic projection deduplicates searches by stable query/path/result evidence, so irrelevant argument changes such as an output-limit probe do not manufacture progress when no new file or symbol evidence appears. A genuinely new query remains meaningful because searched queries are themselves tracked.

### Agent integration

`Agent.run()` computes a baseline semantic fingerprint from the restored cumulative state and then recomputes it after every provider/tool round. The comparison therefore crosses provider messages. A fingerprint change marks meaningful progress; an unchanged fingerprint is passed to `ToolLoopGuard.observeNoProgressRound()`. Existing raw identical-call and prolonged-read-only guards remain in place as complementary backstops.

The exploration projection is also checkpointed through the existing `machineStateFromRuntime()` path, so the semantic detector never becomes a second durable session database. `SessionStore` remains the authoritative transcript/runtime truth.

## Regression coverage

`tests/agent/phase13m-p3-semantic-progress.test.mjs` covers:

1. output-reference/call-ID/generated-ID changes do not change the fingerprint;
2. additional read coverage changes the fingerprint and restore reproduces the same fingerprint;
3. syntactically different task-state calls with the same semantic state are blocked by the semantic detector;
4. mutation, task, and workflow state changes alter the fingerprint;
5. equivalent search calls with irrelevant argument changes do not alter the fingerprint, while new discovered evidence does;
6. semantic exploration state survives an Agent turn boundary and catches rereads made with syntactically different arguments.

## Verification

- P3 focused suite: **6/6 passed**
- Combined Agent/P2/P3 regression: **32/32 passed**
- Production TypeScript build: **passed**

The full Phase 13 and repository-wide rollout gates remain intentionally separate. P3 is complete at the subphase level, but Phase 13M-P4 through P7 and the final Phase 13M gate remain unchecked.
