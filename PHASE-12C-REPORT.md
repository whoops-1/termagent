# TermAgent Phase 12C Report

## Scope

Phase 12C replaces the previous fragmented diff presentation with a shared diff model/parser/renderer used by the main transcript, Ctrl+O inspector, apply-patch output, and edit permission preview.
The implementation was aligned to the implementation interaction model rather than introducing a new UI architecture:

- TermAgent's TUI renders edit/apply-patch diffs inline with one diff primitive, with unified/split selection based on terminal width.
- TermAgent's `DialogSelect` and command palette establish bounded, width-aware selection surfaces.
- TermAgent's session UI uses compact inline tool rows for ordinary activity and block surfaces when detailed content such as diffs is present.
- TermAgent's permission/question surfaces are dock/footer interactions instead of making the conversation itself disappear.
- TermAgent's diff dialog separates source/file selection from file detail and uses one detailed diff view with line numbers and syntax-aware content.
- TermAgent's `StructuredDiff`/diff detail treatment informs the line-level layout and truncation behavior.

## Shared contract

the relevant TermAgent subsystem owns:

- `DiffFile` and `DiffDocument` normalized records
- Git/apply-patch metadata normalization
- hunk/old-line/new-line parsing
- unified and split rendering
- line-number gutters
- add/remove/hunk semantic backgrounds and markers
- syntax-aware code highlighting using TermAgent's existing syntax subsystem
- binary, large, untracked and truncation states
- width-safe rendering and explicit row budgets

No second renderer was added for Ctrl+O or permission previews.

## Production integration

the relevant TermAgent subsystem now consumes the shared diff system for:

1. completed edit/write tool output in the main transcript
2. multi-file apply-patch output in the main transcript
3. Ctrl+O working-tree/file diff inspector
4. per-file diff detail scrolling
5. permission previews for proposed edit changes

The inspector keeps list selection independent from detail scrolling and supports previous/next file movement.

## Geometry rules

- `view = split` at 120+ columns
- `view = unified` below 120 columns
- diff renderer width is explicit and padded to its target width
- line-number width is derived from the largest parsed source/target line number, not change count
- `maxRows` is an inclusive total row budget, including headers and truncation markers

## Verification

- Full `npm test`: **349/349 PASS**
- Focused Phase 12C + UI suite: **32/32 PASS**
- TypeScript production build: **PASS**
- Generated JS syntax checks: **107/107 PASS**
- `npm pack --dry-run`: **PASS**
- `node dist/index.js --version`: **PASS**
- `node dist/index.js --help`: **PASS**
- Clean artifact extraction/build: required before release archive

## Visual QA

Deterministic snapshots were rendered and inspected for the main transcript diff surface and Ctrl+O detail surface at 90 and 140 columns.

## Next phase boundary

Phase 12D remains intentionally untouched. Permission/question conversion to compact docks happens there, using the same shared diff renderer already established by 12C.
