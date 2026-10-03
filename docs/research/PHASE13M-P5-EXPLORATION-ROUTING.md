# Phase 13M-P5 — Exploration routing and agent guidance

## Status

Implementation complete at the subphase level.
This implementation formalizes the exploration guidance already used during Phase 13 into a small adaptive routing layer.

the relevant TermAgent subsystem defines a dedicated `explore` agent and describes it as a fast codebase exploration specialist. Its prompt distinguishes broad file-pattern discovery, content search, and reading known file paths, and asks callers to specify a thoroughness level.

The recorded the relevant TermAgent subsystem uses three key rules that are preserved here:

- Glob for broad file-pattern matching.
- Grep for content/regex search.
- Read when the concrete file path is known.

It also explicitly tells the exploration agent to adapt its search approach rather than assuming one fixed workflow.


The supplied the recorded behavior used for the Phase 13 research was inspected at the recorded behavior.

the relevant TermAgent subsystem strengthens the same pattern with explicit read-only boundaries and a performance instruction to parallelize independent grep/read operations. Its surrounding agent guidance also emphasizes using specialized subagents for independent work while avoiding duplicated searches.

## TermAgent adaptation

TermAgent already has the corresponding primitives:

- `repo_map` for bounded structural context and symbols;
- `glob` for bounded path discovery;
- `grep` for regex-aware content search;
- `read_file` for bounded known-path/range reads;
- `parallelSafe` metadata and provider support for multiple tool calls in one model response;
- durable task/background/parallel agent tools for broader independent work when those tools are available to the active agent.

P5 therefore changes the routing guidance rather than introducing another filesystem-search subsystem.

## Implementation

Added the relevant TermAgent subsystem.

The guidance layer:

1. Infers a semantic thoroughness level (`quick`, `medium`, `very-thorough`) from the request without introducing a fixed call-count target.
2. Chooses a suggested primary tool set from task intent:
   - file-pattern discovery → `glob` then targeted `read_file`;
   - symbol/content/usage questions → `grep` then targeted `read_file`;
   - architecture/structure questions → `repo_map`, then targeted `grep`/`read_file`;
   - known file paths → `read_file`, with search only when connections need verification;
   - broad/ambiguous work → use the minimum structure needed to select the next tool.
3. Explicitly states that the routing is adaptive guidance, not a mandatory `repo_map → glob → grep → read` ceremony.
4. Directs the agent to continue from uncovered read ranges and follow search continuation offsets when results are truncated.
5. Directs independent reads/searches to be parallelized when safe instead of serializing unrelated work.
6. Allows bounded specialized subagents for broad independent exploration when the active tool set exposes them, while prohibiting duplicate parent-side searches.
7. Keeps Explore mode strictly read-only.
8. Requests absolute paths and evidence-based findings in the final exploration report.

`Agent.systemPrompt()` now receives the actual user prompt when constructing Explore guidance. This is important because project-level instructions alone are not the exploration request and would otherwise produce generic routing advice for every task.

Build-mode system prompts also receive a short delegation rule when task/background/parallel tools are present, so broad exploration can be split into bounded independent questions without turning Explore itself into a write-capable agent.

## Design constraints

No fixed sequence is enforced. For example, a request that already identifies the relevant TermAgent subsystem should not be forced through a repository map and a glob search first. Conversely, a request asking how an unfamiliar subsystem is wired can benefit from the map before targeted search.

No fixed tool-call budget is introduced. Thoroughness is expressed as evidence coverage and reconciliation, not a predetermined number of calls. This keeps P5 compatible with P6's semantic-efficiency telemetry and avoids replacing one brittle call-count heuristic with another.

## Verification

Focused routing suite: **4/4 PASS**.

Adjacent hardening and Phase 13 regressions:

- P2 + P3 + P4 + P5: **18/18 PASS**
- Phase 13A + P2-P5 + 13G + 13I + 13J + 13K + 13L: **86/86 PASS**
- Production TypeScript build: **PASS**

Repository-wide `npm test` is not used as a P5 completion claim because the existing aggregate suite still contains unrelated rollout-gate failures and an aggregate timeout. Those are tracked separately and are not P5 routing failures.
