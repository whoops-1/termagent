# TermAgent Phase 13D Report

## Scope

Phase 13D upgrades search and filesystem discovery around TermAgent's existing `ToolRegistry`, path containment, and read-state architecture. The changes improve bounded search, continuation handling, and read-state reuse without introducing a second tool runtime.

## TermAgent-designed behavior


The audited the implementation use ripgrep-backed search/glob helpers, centralized permission-aware path handling, bounded result pagination, and structured truncation metadata. Its glob helper separates a static search directory from a relative pattern and applies centralized exclusions.


The audited the current V2 design expose regex grep, explicit path roots, bounded results, and structured `matches`/`truncated` metadata. Its read filesystem service treats directories as first-class reads and returns paginated directory entries with a continuation offset.

## TermAgent changes

### Shared filesystem-search service

Added `the evidence ledger component` with:

- Shared ignored-directory policy for VCS/build/cache/virtualenv paths.
- Ripgrep-first text search with JSON match parsing.
- Deterministic Node fallback when `rg` is unavailable.
- Real regular-expression semantics in both engines.
- Shared glob matching with `*`, `**`, `?`, character classes, and brace alternatives.
- Explicit result limits and offsets.
- Deterministic path ordering for glob results.
- First-class paginated directory listing.
- Symlink resolution limited to targets contained within the requested directory.
- Shared ignored-path policy is also consumed by repository-map discovery, while retaining repository-map-specific exclusions.
- Abort propagation for search and directory traversal.

### `grep`

`grep` now accepts `pattern`, `path`, `glob`/`include`, `maxResults`, and `offset`. Metadata includes engine, root path, pattern, include filter, returned match count, observed count, truncation, and continuation offset.

### `glob`

`glob` now accepts an optional root `path`, `maxResults`, and `offset`. Metadata includes engine, root, count, truncation, and continuation offset.

### `read_file`

Directory paths are now first-class reads. Directory results are paginated with `offset`/`limit`, return total entry counts and continuation metadata, and reuse the shared ignored-path/symlink policy.

## Verification

Focused Phase 13D suite: 13/13 passing.

Compatibility suite covering Phase 13A, 13B, 13C, and existing tools: 50/50 passing.

TypeScript build: passing.

The aggregate `npm test` timeout recorded during Phase 13A remains an inherited baseline issue and is not treated as fixed by this phase.

## Files

- `the evidence ledger component`
- `the evidence ledger component`
- `tests/phase13d-search-filesystem.test.mjs`
- `docs/PHASE13D-REPORT.md`
- `TODO.md`
