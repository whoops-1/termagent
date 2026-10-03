# Phase 13H — Compaction/context management: preserve state instead of merely summarizing text

## Status

**Implemented and verified.** Phase 13H converts TermAgent context reduction from a single summary step into a staged reduction pipeline and adds a machine-owned context checkpoint alongside the LLM-generated summary. The full session transcript remains durable; the checkpoint becomes the authoritative active provider projection.
Implementation design for Phase 13:

- the implementation the relevant TermAgent subsystem: staged compaction behavior, preservation of recent message units, rolling summary construction, exact tool/error evidence, read-state restoration, and safe compaction retries.
- the implementation the relevant TermAgent subsystem: explicit provider-turn boundaries, durable context reload, interrupted tool settlement, and context-epoch usage around provider turns.
- the implementation the relevant TermAgent subsystem: durable tool result separation from provider-facing projections and explicit state around streamed tool calls.
- the implementation the relevant TermAgent subsystem: rebuilding the next provider turn from durable session state after tool settlement and preserving continuation semantics.
- the implementation the relevant TermAgent subsystem: tool-call/result pairing and interrupted-tool representation.
- the implementation `specs/v2/session.md`: durable session history, projected context, and session-owned state boundaries.
- the implementation the relevant TermAgent subsystem: recent-turn preservation, compact-boundary handling, rolling summaries, file-read-state restoration, exact error retention, and retry-safe compaction.
- the implementation the relevant TermAgent subsystem and the relevant TermAgent subsystem: summary-update structure and memory-oriented preservation of important recent state.


## Staged reduction pipeline

the relevant TermAgent subsystem now performs context reduction in this order:

1. Oversized tool output is first bounded by the existing Phase 13F `ToolOutputStore` projection.
2. `microPruneToolResults()` rewrites only old tool-result payloads that are safe to shrink while preserving their assistant tool-call/result pairing and stable call IDs.
3. Recent turns remain intact as complete message units; a multi-call assistant message is retained together with all of its corresponding tool results.
4. Full `compactMessages()` runs only when micro-pruning cannot satisfy the request budget.
5. A successful reduction updates an explicit durable context checkpoint and the active in-memory projection used for the next provider turn.

The micro-prune stage uses a deterministic marker and, where available, a `tool-output://` reference so the full result remains recoverable without re-injecting it automatically.

## Machine-owned context state

Added the relevant TermAgent subsystem with `ContextMachineState` and `ContextCheckpointRecord`.

Machine state is persisted separately from prose summary and contains:

- read-file coverage, file identity, hashes, and requested ranges
- managed tool-output references
- active background task IDs
- workflow state
- durable todo state
- important file mutation evidence and hashes
- continuation metadata such as the latest user prompt and next action
- context epoch/checkpoint identity
- source-event count and projection hash
- summary revision

Structured state remains structured on disk. Only a bounded rendering is exposed to the provider when necessary.

## Read-state preservation and evidence rehydration

the relevant TermAgent subsystem now exposes bounded `rehydrateReadCoverageEvidence()` in addition to the existing session cache restoration path.

After compaction, TermAgent:

- retains the in-memory `FileReadStateCache`
- marks cached reads as no longer present in the active provider context
- verifies file existence, mtime, size, and optional SHA-256 identity before reconstructing evidence
- rehydrates only the requested line ranges
- applies a strict token budget and file-count bound

Stale or changed files are not silently reintroduced as trusted evidence.

## Rolling summary preservation

the relevant TermAgent subsystem now carries the previous summary into subsequent summaries. Newer conversation evidence is appended into the newly constructed sections, while exact tool call anchors, error strings, verification evidence, paths, and read continuation ranges are retained where space permits.

The summary builder keeps structured sections for objective, important details, completed/active/blocked work, todo, next move, and relevant files. The fitting logic preserves section structure instead of flattening all information into an unstructured character slice.

## Context epochs and checkpoints

the relevant TermAgent subsystem adds durable `context.checkpoint` events and helpers for saving/loading the active checkpoint.

Checkpoint records contain:

- epoch
- checkpoint ID
- source event count
- projection hash
- summary revision
- current active projection messages
- machine state
- reduction stage (`baseline`, `micro-prune`, or `full-compaction`)

Checkpoint persistence is idempotent for the same session/turn/epoch/projection state. Undo/branch history invalidates checkpoints tied to abandoned turns, while the immutable/full transcript remains untouched.

The next provider run prefers the latest valid checkpoint projection and reconstructs fresh provider-facing system context around it.

## Durable continuation behavior

`Agent.run()` uses the checkpoint projection for durable turn reload after local tool settlement. A micro-pruned projection is explicitly promoted to the active continuation baseline, preventing already-pruned history from being pulled back into the next provider request.

Compaction is intentionally not executed while a tool is still running. The tool settlement boundary remains the synchronization point, matching the provider runtime-turn model. A dedicated regression verifies that no context checkpoint is created in the middle of an executing tool.

## Adversarial verification

`tests/phase13h-compaction-context.test.mjs` covers:

- old tool-result micro-pruning with recent pair preservation
- full compaction retaining exact tool-call anchors, compiler/error strings, verification evidence, and read ranges
- machine state for read coverage, tool-output references, active tasks, workflow, todo, mutations, and continuation data
- repeated reads and bounded read-state rehydration
- checkpoint idempotency and undo invalidation
- rolling summary preservation across repeated compaction
- restoring checkpoint projection instead of replaying the full durable transcript
- many short tool-call histories
- large todo state under a bounded rendered context
- completed subagent results with durable output references
- interrupted lifecycle recovery
- preventing compaction during tool execution

## Verification

- TypeScript build: **PASS**
- Phase 13H dedicated suite: **13/13 PASS**
- Phase 13A–13H targeted regression matrix: **95/95 PASS**
- Broader agent/context/execution/provider compatibility sweep: **108/108 PASS**

The historical aggregate `npm test` runner stall remains a separate archive issue and is not counted as a Phase 13H failure or success.

## Files
- `tests/phase13h-compaction-context.test.mjs`
- `docs/phase13/tool-inventory.json`
- `docs/PHASE13H-REPORT.md`
- `docs/CONFIGURATION.md`
- `TODO.md`
