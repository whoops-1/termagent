# Phase 5 Hardening

## Scope

Phase 5 closes two release-blocking interaction and session-safety defects found during real terminal validation.

## Snapshot hardening

Snapshot creation now builds an explicit candidate file set from the relevant working tree, evaluates Git ignore rules against that set, and stages only allowed paths through NUL-delimited pathspec input. This prevents ignored directories from being treated as explicit `git add` targets while remaining safe for unusual filenames.

The regression suite covers ignored `dist/` and `.termagent/` directories during snapshot creation and restore.

## Command completion ranking

Command completion now ranks matches in this order:

1. exact trigger
2. prefix match
3. fuzzy subsequence match

Ordering inside each tier remains stable. This prevents longer commands such as `/checkpoints` from outranking the exact `/checkpoint` trigger simply because it appeared first in the source list.

## Verification

- TypeScript build: pass
- Full test suite: 166/166 pass
- npm package dry-run: pass
- Compiled CLI smoke with ignored directories: pass
- Source hygiene scan: no conflict markers and no embedded credentials
