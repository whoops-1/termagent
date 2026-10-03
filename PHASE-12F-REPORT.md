# TermAgent Phase 12F — Responsive Hardening and Visual Freeze

Date: 2026-09-28

## Scope
Phase 12F is UI/UX-only. Provider/model/backend feature-parity architecture was not changed.

The implementation preserves the Phase 12 UI contract through viewport-derived bounds, reusable selection/geometry primitives, compact transient surfaces, and explicit input ownership. See the Phase 12 research boundary in `TODO.md`.

## Completed work

### Responsive viewport hardening
- Tested the required 40x20, 48x20, 56x20, 60x24, 64x24, 80x24, 100x30, 120x30, and 160x40 matrix.
- Added a short-viewport splash fallback so the full banner yields to the compact header before it can consume the minimum live body.
- Preserved the full splash at 60x24 where the viewport can still afford the minimum body.
- Normalized every final frame row to the exact terminal width so blank rows cannot drift below the geometry contract.

### Composer and transient surfaces
- Corrected wide composer budgeting so its reserved tip row is actually rendered instead of being clipped away.
- Resized picker, permission, question, and inspector surfaces through active-state scenarios and narrow/wide transitions.
- Added explicit long command-name/description regression coverage.
- Added explicit long-file-path regression coverage.
- Kept huge tool output capped by the inspector viewport.
- Kept 100+ changed-file inspectors bounded and navigable.

### Input ownership and PTY behavior
- Preserved transient-surface ownership during picker, permission, question, and inspector flows.
- Verified active-turn inspector ownership and restoration of the turn input handler.
- Fixed the production PTY fixture so it closes the renderer before exiting, preventing lingering TTY handles from contaminating later regression files.

### Visual snapshots
Deterministic text-frame snapshots cover:
- startup
- narrow startup fallback
- transcript
- picker
- inline diff
- diff inspector
- permission dock
- question dock

Snapshot generation uses a fixed clock and plain terminal capability so the frame content is byte-stable.

## Tests

- Full regression: **391/391 PASS** across **47 test files**, executed as isolated per-file processes.
- Focused Phase 12F UI + PTY: **26/26 PASS**.
- Production TypeScript build: **PASS**.
- Generated production JavaScript syntax: **109/109 PASS**.
- `npm pack --dry-run`: **PASS**.
- CLI `--version`: **PASS**.
- CLI `--help`: **PASS**.
- CLI `--doctor --json`: **PASS**.
- Deterministic visual snapshot regression: **PASS**.
- Source-hygiene scan: **PASS**.

The 391-test regression total is the Phase 12E 365-test baseline plus the 26 Phase 12F UI/PTY tests.

## Responsive matrix

| Terminal | Result |
|---|---|
| 40x20 | PASS |
| 48x20 | PASS |
| 56x20 | PASS |
| 60x24 | PASS |
| 64x24 | PASS |
| 80x24 | PASS |
| 100x30 | PASS |
| 120x30 | PASS |
| 160x40 | PASS |

## Visual QA artifacts

- `tests/qa/phase12f-snapshots/startup-60x24.txt`
- `tests/qa/phase12f-snapshots/narrow-fallback-56x20.txt`
- `tests/qa/phase12f-snapshots/transcript-80x24.txt`
- `tests/qa/phase12f-snapshots/transcript-160x40.txt`
- `tests/qa/phase12f-snapshots/picker-40x20.txt`
- `tests/qa/phase12f-snapshots/picker-80x24.txt`
- `tests/qa/phase12f-snapshots/inline-diff-80x24.txt`
- `tests/qa/phase12f-snapshots/diff-inspector-40x20.txt`
- `tests/qa/phase12f-snapshots/diff-inspector-160x40.txt`
- `tests/qa/phase12f-snapshots/permission-48x20.txt`
- `tests/qa/phase12f-snapshots/permission-100x30.txt`
- `tests/qa/phase12f-snapshots/question-40x20.txt`
- `tests/qa/phase12f-snapshots/question-100x30.txt`

## Clean extracted-artifact smoke
The release archive was extracted into a fresh directory and rechecked for build/CLI/package integrity plus the Phase 12F regression surface. The extracted source remains self-contained; the final archive contains the frozen UI code, tests, deterministic snapshot fixtures, and reports.

## Freeze boundary
Phase 12F is complete. Phase 12 is now UI-frozen. Future feature-parity work must consume the frozen geometry, transcript, picker, diff, permission/question dock, Todo/status, focus, resize, and input-ownership contracts rather than reopening the presentation architecture.
