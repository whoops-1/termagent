# Phase 13B — Read Tool State / Context Correctness

Status: **implemented; focused gate passes**
Phase 13B follows the documented interaction model `FileStateCache` + `FileReadTool` pattern and the implementation `read` tool pagination/output contract. The implementation is adapted to TermAgent's existing `ToolDefinition`, `ToolContext`, `Agent.run()`, and `SessionStore` rather than introducing a parallel execution stack.

## Implemented

- Added the relevant TermAgent subsystem with a bounded session-scoped LRU `FileReadStateCache`.
- Cache keys are canonical absolute paths; state records file mtime/size, total lines, recent ranges, normalized content segments, and last-use time.
- Exact unchanged range rereads return a compact unchanged result while the earlier result is still present in context.
- After compaction, cached ranges become eligible for one-time rehydration from memory, so the model can recover file evidence without another filesystem read.
- Overlapping requests subtract already covered ranges and read only the uncovered line intervals.
- Read metadata now includes canonical path, lineStart, lineEnd, totalLines, truncated, nextLine, requested/returned ranges, cache status, and cache statistics.
- Read output is capped at 2,000 lines and 50 KiB; long output retains both head and tail with explicit continuation guidance.
- Individual lines are bounded to 2,000 characters.
- Binary extensions, binary-like content, UTF-16/UTF-32 BOMs, and invalid UTF-8 samples are rejected with model-visible errors.
- CRLF is normalized for model-facing text while Unicode content remains intact.
- Successful `write_file` and `edit_file` operations invalidate the read-state cache for the affected path.
- `Agent.run()` now supplies the session read cache to tools and records a compact recent read-state snapshot in compaction events.

## Regression coverage

`tests/phase13b-read-state.test.mjs` covers:

- range merging/subtraction;
- exact duplicate suppression;
- post-compaction rehydration;
- overlapping range continuation;
- mtime/size invalidation;
- bounded LRU eviction;
- 2,000-line continuation behavior;
- 50 KiB head/tail bounding;
- binary rejection;
- invalid UTF-8 rejection;
- Unicode and CRLF handling;
- successful write/edit cache invalidation;
- the 1–1000 → compaction → repeated reread → 1001–1372 scenario;
- real `Agent.run()` compaction integration and durable read-state metadata.

## Verification

- TypeScript build: **PASS**.
- Phase 13B focused suite: **PASS, 14/14 tests**.
- The reproduction demonstrates that previously read 200–1000 ranges can be rehydrated after compaction and the previously unreachable 1001–1372 range is subsequently read successfully.

## Deliberate scope boundary

Write/edit stale-read protection, atomic write-if-unchanged semantics, and richer mutation metadata remain Phase 13C work. Phase 13B only invalidates cached read state after successful mutations so stale read evidence is not reused.

The aggregate repository test command remains the inherited Phase 13A baseline issue and is not reclassified as fixed by 13B.
