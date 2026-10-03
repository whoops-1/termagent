# Phase 13M-P2: Read Coverage and Semantic Exploration State

## Decision

TermAgent keeps two related but distinct pieces of state:

1. `FileReadStateCache` remains the authoritative **derived read cache** for file freshness, cached segments, request history, and mutation preconditions.
2. `ExplorationState` is a bounded **derived/reconstructible exploration projection** consumed by the agent loop. It records which files, ranges, searches, and symbols have already produced useful evidence.

`ExplorationState` is not a replacement for `SessionStore` durable truth. It is checkpointed as part of the existing context-machine projection so an agent can resume exploration efficiently, but the durable session event log remains authoritative.
The exploration model is built on four rules: file state stays normalized and bounded; path/range/version checks prevent redundant reads; read results carry explicit coverage metadata; and subagents work from isolated read-state copies.

P2 extends the existing `FileReadStateCache` rather than creating another cache.

## Read coverage semantics

Every normal text `read_file` result now exposes structured coverage metadata:

```text
requestedRange
previouslyCovered
newlyCovered
resultingCoverage
fullCoverage
overlapNoNewInfo
mtimeMs
size
totalLines
contentHash
```

`newlyCovered` is calculated from the ranges actually returned and is therefore conservative when the bounded renderer truncates or otherwise omits content. `fullCoverage` means the observed line coverage spans the complete file. This is intentionally different from the stricter mutation-safety rule used by `FileReadStateCache`: exploration may know that every line was observed, while mutation still requires complete, fresh cached evidence suitable for conditional writing.

When file metadata or content identity changes, previous exploration coverage is discarded for that file. The old ranges cannot silently satisfy a new-version exploration requirement.

A request whose range is completely inside already covered ranges produces `overlapNoNewInfo=true` and `newlyCovered=[]`. That result is meaningful to the future P3 semantic no-progress detector, even though it does not itself terminate a run.

## Exploration projection

the relevant TermAgent subsystem defines versioned `ExplorationState` with bounded collections for:

- discovered canonical file paths;
- per-file read coverage and file-version metadata;
- recent read observations;
- canonicalized `grep`, `glob`, and `repo_map` search observations;
- discovered symbols;
- a monotonically increasing meaningful-progress revision.

Search observations use the Phase 13M-P1 canonical tool-call identity, so JSON object key ordering does not create artificial search novelty.

`repo_map`, `grep`, and `glob` expose bounded discovered-file metadata to this projection. `repo_map` additionally contributes symbols. The projection records novelty rather than retaining arbitrary tool output.

## Agent integration

After a tool settles, the agent feeds the tool's structured metadata into `ExplorationState.observeTool()`. New read ranges, newly discovered files, new search signatures, and new symbols count as meaningful exploration progress. Covered rereads do not.

The exploration snapshot is included in the existing context-machine checkpoints alongside `FileReadStateCache` state. On checkpoint restore, it is reconstructed into a fresh `ExplorationState` instance. No renderer or transport owns this state.

## Bounds and recovery

The projection is deliberately bounded so a large repository cannot grow an unbounded in-memory history. Current limits are 256 tracked files, 512 tracked symbols, 96 read observations, and 96 search observations. These limits bound the projection only; they do not impose a hard repository capability limit.

Because the projection is derived, a future rebuild/reconciliation path may reconstruct it from the session/tool evidence. Its absence must never invalidate durable session history.

## Verification

Focused P2 tests cover:

- first read coverage;
- overlapping reads that add uncovered lines;
- overlapping reads with zero new information;
- file-version invalidation;
- search novelty and duplicate searches;
- discovered files and symbols;
- checkpoint restoration;
- agent-level meaningful-progress integration.
