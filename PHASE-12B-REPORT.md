# TermAgent Phase 12B Report

Phase: 12B — Transcript and command picker
Status: COMPLETE
Date: 2026-09-28

## Scope

UI/UX only. No provider/model/tool feature-parity work was introduced.

## Transcript

- Removed repeated `◆ You` and `◆ TermAgent` labels from normal transcript rendering.
- Preserved the user left-border/panel treatment.
- Kept assistant reasoning/response content primary, with compact metadata retained.

## Command picker

- Bounded width: 60 columns maximum.
- Terminal-constrained width: available width instead of overflow.
- Header padding: 4 left / 4 right.
- List padding: 1 left / 1 right.
- Item padding: 3 left / 3 right.
- Command-name cell: 24 columns.
- Description gap: 2 columns.
- Fixed layout at >= 56 terminal columns.
- Stacked layout below 56 columns.
- Global selection preserved beyond the visible window.
- Height-aware visible rows.
- Removed incorrect description-budget subtraction for non-rendered query/footer text.
- Snapshots: 40, 48, 56, 60, 64, 80, 120 columns.

## Verification

- Full test suite: 339/339 PASS.
- TypeScript production build: PASS.
- Production JS syntax: 107/107 PASS.
- Focused Phase 12B tests: PASS.

## Next boundary

Phase 12C is not implemented here. The next work remains the shared diff system, inline diffs, Ctrl+O diff inspection, and permission-preview reuse.
