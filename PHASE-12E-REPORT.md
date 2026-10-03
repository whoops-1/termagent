# TermAgent Phase 12E — Todo and Interaction Consistency

Date: 2026-09-28

## Scope
Phase 12E is UI/UX-only. Provider/model/backend feature-parity architecture was not changed.

Implementation uses the established TermAgent interaction model: compact transcript-first surfaces, bounded selection/dock geometry, semantic status states, and terminal-safe input ownership.

## Completed work

### Todo lifecycle
- Active Todo UI now renders only pending/in-progress items.
- Completed Todo entries remain represented in session history and the aggregate completion count.
- A completed-only Todo set renders no active Todo panel.

### Status vocabulary
A shared semantic vocabulary is now used by Todo, tool activity, transient activity, and inspector state:

`pending`, `working`, `waiting`, `done`, `failed`, `cancelled`

The activity renderer now uses terminal-state-aware markers (`!`, `✓`, `×`, `~`) and avoids duplicated labels such as `Completed done` or `failed failed`.

### Geometry
the corresponding module centralizes content width, frame bounds, row fitting, remaining-width, and column-width calculations. Picker, diff, transcript, and surface renderers use the shared helpers so borders/padding are not double-counted.

### Color capability geometry
Plain, ANSI16, ANSI256, and truecolor output are tested after ANSI stripping to ensure identical row geometry.

### Input ownership
SGR and X10 mouse click sequences are consumed by the input layer so synthetic terminal clicks cannot become keypresses or abort an active agent turn. Wheel sequences still drive scrolling.

### Banner correction
The supplied `banner-font.js` correction was mirrored in the corresponding module: rows are no longer right-trimmed and every ANSI Shadow word row is right-padded to the widest row. This prevents the lower `T` stem from shifting left during per-row centering. See `banner-font.js` for the row-width preservation logic.

## Tests

- Full test suite: **365/365 PASS**
- Focused Phase 12E + UI tests: **26/26 PASS**
- Production TypeScript build: **PASS**
- Generated production JavaScript syntax: **109/109 PASS**
- `npm pack --dry-run`: **PASS**
- CLI `--version`: **PASS**
- CLI `--help`: **PASS**
- CLI `--doctor --json`: **PASS**
- Clean deterministic visual renders: **PASS**

The full suite was run with `--test-force-exit` so lingering process handles cannot turn a completed test run into a false timeout.

## Visual QA

- `docs/assets/phase12e/01-picker-80x20.png`
- `docs/assets/phase12e/02-picker-48x16.png`
- `docs/assets/phase12e/03-shared-diff-80x16.png`
- `docs/assets/phase12e/04-permission-dock-80x8.png`
- `docs/assets/phase12e/05-status-vocabulary-80x8.png`

## Freeze boundary
Phase 12E is complete. Phase 12F remains the responsive hardening and final UI-freeze stage. No feature-parity implementation is included in this phase.
