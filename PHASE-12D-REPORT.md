# TermAgent Phase 12D Report

## Scope
Phase 12D converts permission and question interactions from full-screen/blocking UI into bounded dock surfaces, following the documented interaction model interaction model and preserving the existing TermAgent renderer/input architecture. No provider/model/backend parity work was introduced.

## Implemented

### Permission dock
- Permission requests now render as a compact dock above the prompt rather than taking over the terminal.
- The transcript remains visible while the agent waits for approval.
- The dock shows a semantic permission title, bounded request details, compact Allow once / Always allow / Reject controls, and shared diff preview for write/edit approvals.
- The shared Phase 12C diff renderer remains the source for the permission diff preview.
- Prompt input is disabled while the dock owns input.
- Keyboard ownership stays local to the pending permission request.

### Question dock
- Question requests use the same bounded dock frame.
- The transcript and composer remain visible.
- Only a bounded option window is displayed; overflow is reported as a range such as `… showing 1-4 of 6`.
- Selection/navigation stays local to the question state.
- Custom answer editing stays inside the dock and does not overwrite the composer draft.

### Shared surface
`renderDockFrame()` in the corresponding module centralizes the bounded frame geometry used by both permission and question surfaces.
The implementation builds on TermAgent's bounded dock primitives, shared selection model, session renderer, and diff surface. Permission and question interactions remain semantic states rendered through those shared components.

Relevant design files:

## Tests

Focused Phase 12C + 12D suite: **24/24 passed**.
Full project suite: **358/358 passed**.
Production TypeScript build: **passed**.
Generated production JavaScript syntax: **107/107 passed**.
CLI `--version`: **passed**.
CLI `--help`: **passed**.
`npm pack --dry-run`: **passed**.
Compact dock scenarios at 80x20 and 48x20: **passed**.

A legacy Phase 12C assertion was updated to strip ANSI before matching diff text. The behavior under test remains the shared diff renderer; the adjustment prevents semantic color escape sequences from making content assertions brittle.

## Visual QA
- `phase12d-permission.png`
- `phase12d-question.png`

The permission and question surfaces were inspected in both their transcript-preserving dock state and compact terminal configurations.

## Changed files
- `tests/ui-phase12d.test.mjs`
- `tests/ui.test.mjs`
- `tests/phase12c-diff-ui.test.mjs`
- `TODO.md`

## Boundary
Phase 12E remains intentionally untouched. Phase 12D is complete and the next work should continue with the remaining UI-only hardening before feature parity resumes.
