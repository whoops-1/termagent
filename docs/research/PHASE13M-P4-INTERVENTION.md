# Phase 13M-P4 — Exploration intervention policy

## Scope

P4 adds an intervention ladder on top of the semantic no-progress detector from P3. The existing global loop guard remains the emergency backstop, while repeated exploration churn receives progressively more useful guidance before a hard stop.
TermAgent's inspected processor uses a hard doom-loop threshold for repeated tool calls with identical input. Its implementation is useful as the safety backstop, but it does not provide the three-stage exploration intervention required by the TermAgent roadmap. A recent the a documented issue also documents that current doom-loop detection can miss cross-message repetitions, reinforcing the need for TermAgent's cumulative semantic state rather than message-local tool-part matching.

TermAgent's documented repository-map workflow and Explore-oriented guidance support using structural map, file-pattern search, content search, and targeted reads as complementary exploration primitives. TermAgent therefore keeps intervention routing semantic and adaptive rather than imposing a fixed discovery ceremony.

References inspected:

- the processor loop records bounded no-progress and intervention state in the existing session/runtime path.
- the repository-map documentation for complementary `repo_map` / Glob / Grep / Read exploration.
- the a documented issue #25254 documenting limitations of message-local doom-loop detection.

## Intervention ladder

The semantic detector now uses three configurable stages, with defaults of 1 / 2 / 3 consecutive no-progress rounds:

1. **Nudge** — a transient system message tells the model that the round produced no new semantic evidence and asks it to change strategy.
2. **Constrain** — semantic signatures of the redundant exploration actions are remembered. The next occurrence is rejected before tool execution, while the model receives guidance to choose a different tool, query/path, or uncovered range.
3. **Stop** — the exploration subtask is ended with an explicit reason and a bounded evidence summary: discovered files, read observations, search observations, and symbols.

The intervention message is kept out of durable session history. This prevents loop-safety plumbing from becoming model-visible historical truth after reload or compaction.

## Semantic action constraints

For exploration actions, constraint identity is intentionally narrower than the general P1 tool-call identity:

- `read_file`: path + line range.
- `grep`: pattern + path + include/exclude selectors.
- `glob`: pattern + path.
- `repo_map`: focused files + focused symbols.

Cosmetic or output-shaping values such as probe fields, output limits, and generated IDs do not let a constrained exploration action bypass the intervention. Legitimately different ranges, queries, or discovery tools remain available.

## Bounded configuration

The semantic stop threshold is clamped to a maximum of 12. The nudge and constraint stages are independently configurable but are also bounded and clamped to remain at or below the stop threshold.

Environment variables:

- `TERMAGENT_SEMANTIC_NUDGE_THRESHOLD` — default `1`, bounded to `1..12`.
- `TERMAGENT_SEMANTIC_CONSTRAIN_THRESHOLD` — default `2`, bounded to `2..12`.
- `TERMAGENT_SEMANTIC_LOOP_THRESHOLD` — default `3`, bounded to `2..12`.

This allows specialized agents to tolerate additional semantic no-progress rounds without permitting an unbounded safety threshold.

## Runtime behavior

The intervention is evaluated after a provider/tool round using the P3 cumulative semantic fingerprint. On a nudge or constrain stage, the run remains active. On a constrain match, the affected tool call becomes a normal structured tool error and is persisted through the existing `ToolCallLifecycle` path; it is not executed and does not acquire a side effect.

A meaningful semantic change clears prior constrained actions. Therefore an agent that makes real progress can safely revisit an earlier path or query later.

The existing exact-repeat, write-only, read-only, and workflow/global guards remain intact. P4 does not replace those protections.

## Verification

Focused P4 tests cover:

- nudge → constrain → stop escalation;
- clearing constraints after meaningful progress;
- allowing different read ranges and different search actions;
- bounded thresholds for specialized agents;
- bounded intervention messages and collected evidence;
- real Agent integration with a redundant read constrained before execution;
- transient intervention notices remaining outside durable session messages.

Focused P4: `6/6` passing.

Combined agent + P2 + P3 + P4 regression: `38/38` passing.

All Phase 13A-L plus P2-P4 focused suites: `177/177` passing.

Frozen UI/PTy regression suites used at the phase gate: `45/45` passing.

Production TypeScript build: passing.

Generated production JavaScript syntax checks: `125/125` passing.

`npm pack --dry-run`: passing; P4 runtime source is included.

## Gate disposition

The P4 implementation and focused verification are complete, but the full repository phase gate is **blocked by unrelated pre-existing suite failures and an aggregate test-run timeout**. The repository-wide run reached the existing failures in `/auto`, Phase 12F resize, multiple Phase 2 context tests, and the existing Phase 13F diff test, then did not complete the full suite before timeout.

P4 is therefore recorded as **implementation-complete / gate-blocked** rather than incorrectly marking the phase fully complete.
